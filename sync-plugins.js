import { context, getOctokit } from '@actions/github';
import fs from 'fs';
import gitUrlParse from 'git-url-parse';
import path from 'path';
import {
  createAlgoliaItem,
  createWebflowItem,
  deleteAlgoliaItem,
  deleteWebflowItem,
  findPluginByName,
  formatTitle,
  getNpmDownloads,
  getReadmeContent,
  getRepoInfo,
  listAlgoliaItems,
  listWebflowCollectionItems,
  updateAlgoliaItem,
  updateWebflowItem,
} from './utils.js';

// Function to read file
function getGithubPluginsList() {
  const filePath = path.resolve('plugins.json');
  const pluginsData = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(pluginsData);
}

const createdPlugins = [];
const updatedPlugins = [];
const deletedPlugins = [];
const failedPlugins = [];

const BATCH_SIZE = 5; // Adjust the batch size as needed
const DELAY_MS = 1000; // Delay between batches to avoid rate limits
/**
 * Generates a detailed sync report.
 * @returns {string} - The sync report in markdown format.
 */
const generateReport = () => {
  return `
## Sync Report
- **Created plugins**: ${createdPlugins.length}
  ${createdPlugins.length > 0 ? createdPlugins.map((plugin) => `  - ${plugin}`).join('\n') : ''}
- **Updated plugins**: ${updatedPlugins.length}
- **Deleted plugins**: ${deletedPlugins.length}
  ${deletedPlugins.length > 0 ? deletedPlugins.map((plugin) => `  - ${plugin}`).join('\n') : ''}
- **Failed plugins**: ${failedPlugins.length}
  ${failedPlugins.length > 0 ? failedPlugins.map((plugin) => `  - **${plugin.name}**: ${plugin.reason}`).join('\n') : ''}
  `;
};

/**
 * Posts a comment to the PR with the sync report or updates the previous comment if it exists.
 * @param {string} report - The sync report.
 */
const postReportToPR = async (report) => {
  const token = process.env.GITHUB_TOKEN;
  const octokit = getOctokit(token);
  const { owner, repo } = context.repo;
  const pullRequestNumber = context.payload.pull_request.number;

  // Fetch existing comments on the PR
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullRequestNumber,
  });

  // Find an existing comment that starts with the report heading
  const existingComment = comments.find((comment) =>
    comment.body.startsWith('## Sync Report'),
  );

  if (existingComment) {
    // Update the existing comment
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body: report,
    });
    console.log('Report updated on the PR successfully.');
  } else {
    // Create a new comment
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullRequestNumber,
      body: report,
    });
    console.log('Report posted to the PR successfully.');
  }
};
/**
 * Processes a single GitHub plugin, syncing it with Webflow and Algolia.
 * @param {Object} githubPlugin - The plugin data from GitHub.
 * @param {Array} webflowPlugins - The list of plugins from Webflow.
 * @param {Set} webflowPluginIds - The set of Webflow plugin IDs for quick lookup.
 */
const processPlugin = async (
  githubPlugin,
  webflowPlugins,
  webflowPluginIds,
) => {
  try {
    const webflowPlugin = findPluginByName(webflowPlugins, githubPlugin.name);
    const { name, description, githubUrl, status } = githubPlugin;
    const { source, owner, name: repo } = gitUrlParse(githubUrl) || {};
    const slug = path.basename(githubPlugin.githubUrl);

    const [repoInfo, npmDownloads, readmeContent] = await Promise.all([
      getRepoInfo({ owner, repo, source }),
      getNpmDownloads({ packageName: name, repoName: repo }),
      getReadmeContent({ owner, repo, source }),
    ]);

    const { githubStars, authorAvatar, authorLink, authorName } =
      repoInfo || {};
    const { content } = readmeContent || {};

    if (!content) {
      console.log(`No README content found for ${name}`);
      failedPlugins.push({
        name: githubPlugin.name,
        reason: 'No README content found',
      });
      return;
    }

    const fieldData = {
      name,
      title: formatTitle(name),
      slug,
      description,
      github: githubUrl,
      content,
      'npm-downloads': npmDownloads || 0,
      'github-stars': githubStars || 0,
      'author-link': authorLink,
      'author-name': authorName,
      'author-avatar': authorAvatar,
      active: status && status === 'active',
    };

    const algoliaItem = {
      objectID: slug,
      name,
      description,
      githubUrl,
      npmDownloads: npmDownloads || 0,
      githubStars: githubStars || 0,
      authorLink,
      authorName,
      authorAvatar,
    };

    if (webflowPlugin) {
      console.log('UPDATING WEBFLOW ITEM');
      await updateWebflowItem(
        process.env.WEBFLOW_PLUGINS_COLLECTION_ID,
        webflowPlugin.id,
        fieldData,
      );
      await updateAlgoliaItem(algoliaItem);
      updatedPlugins.push(githubPlugin.name);
    } else {
      console.log('CREATING WEBFLOW ITEM');
      await createWebflowItem(
        process.env.WEBFLOW_PLUGINS_COLLECTION_ID,
        fieldData,
      );
      await createAlgoliaItem(algoliaItem);
      createdPlugins.push(githubPlugin.name);
    }

    webflowPluginIds.delete(githubPlugin.id);
  } catch (err) {
    console.error(`Failed to process ${githubPlugin.name}`, err);
    failedPlugins.push({
      name: githubPlugin.name,
      reason: `Webflow or Algolia error: ${err.message}`,
    });
  }
};

/**
 * Main function to orchestrate the sync process.
 */
const syncPlugins = async () => {
  try {
    const githubPlugins = getGithubPluginsList();
    console.log(`Found ${githubPlugins.length} Github Plugins`);

    const algoliaPlugins = await listAlgoliaItems();
    console.log(`Found ${algoliaPlugins.length} Algolia Plugins`);

    const webflowPlugins = await listWebflowCollectionItems(
      process.env.WEBFLOW_PLUGINS_COLLECTION_ID,
    );
    console.log(`Found ${webflowPlugins.length} Webflow Plugins`);

    const webflowPluginIds = new Set(
      webflowPlugins.map((plugin) => plugin.name),
    );

    for (let i = 0; i < githubPlugins.length; i += BATCH_SIZE) {
      const batch = githubPlugins.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map((githubPlugin) =>
          processPlugin(githubPlugin, webflowPlugins, webflowPluginIds),
        ),
      );
      if (i + BATCH_SIZE < githubPlugins.length) {
        await sleep(DELAY_MS);
      }
    }

    for (const webflowPlugin of webflowPlugins) {
      if (!findPluginByName(githubPlugins, webflowPlugin.fieldData.name)) {
        console.log('DELETING WEBFLOW ITEM');
        await deleteWebflowItem(
          process.env.WEBFLOW_PLUGINS_COLLECTION_ID,
          webflowPlugin.id,
        );
        await deleteAlgoliaItem(webflowPlugin.fieldData.slug);
        deletedPlugins.push(webflowPlugin.fieldData.name);
      }
    }

    console.log('Sync process completed.');
    const report = await generateReport();
    console.log(report);

    if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
      await postReportToPR(report);
    }
  } catch (error) {
    console.error('An error occurred during the sync process:', error);
    process.exit(1);
  }
};

syncPlugins();
