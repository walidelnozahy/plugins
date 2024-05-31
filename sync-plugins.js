import fs from 'fs';
import gitUrlParse from 'git-url-parse';
import markdownMagic from 'markdown-magic';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createAlgoliaItem,
  createWebflowItem,
  deleteAlgoliaItem,
  deleteWebflowItem,
  findPluginByName,
  formatTitle,
  getErrorMessage,
  getNpmDownloads,
  getReadmeContent,
  getRepoInfo,
  isPluginEqual,
  listAlgoliaItems,
  listWebflowCollectionItems,
  sleep,
  updateAlgoliaItem,
  updateWebflowItem,
} from './utils.js';

// Get the current directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const DELAY_MS = 2000; // Delay between batches to avoid rate limits

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

      // Delete the plugin if it exists in Webflow and no README content is found
      if (webflowPlugin) {
        await processDeletePlugin(webflowPlugin);
      }
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
      // Check if the content has changed
      const hasChanged = isPluginEqual(
        githubPlugin,
        webflowPlugin.fieldData,
        content,
      );

      if (hasChanged) {
        console.log('UPDATING WEBFLOW ITEM');
        await updateWebflowItem(
          process.env.WEBFLOW_PLUGINS_COLLECTION_ID,
          webflowPlugin.id,
          fieldData,
        );
        await updateAlgoliaItem(algoliaItem);
        updatedPlugins.push(githubPlugin.name);
      } else {
        console.log(`No changes detected for ${name}, skipping update.`);
      }
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
    console.error(
      `Failed to process ${githubPlugin.name}`,
      getErrorMessage(err),
    );
    failedPlugins.push({
      name: githubPlugin.name,
      reason: `Webflow or Algolia error: ${getErrorMessage(err)}`,
    });
  }
};
/**
 * Processes a single Webflow plugin for deletion.
 */
const processDeletePlugin = async (webflowPlugin) => {
  try {
    console.log('DELETING WEBFLOW ITEM');
    await deleteWebflowItem(
      process.env.WEBFLOW_PLUGINS_COLLECTION_ID,
      webflowPlugin.id,
    );
    await deleteAlgoliaItem(webflowPlugin.fieldData.slug);
    deletedPlugins.push(webflowPlugin.fieldData.name);
  } catch (err) {
    console.error(
      `Failed to process deletion of ${webflowPlugin.fieldData.name}`,
      getErrorMessage(err),
    );
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
    // const plugin = githubPlugins.find(
    //   (plugin) => plugin.name === 'serverless-cf-vars',
    // );
    // await processPlugin(plugin, webflowPlugins, webflowPluginIds);
    // return;
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
        await processDeletePlugin(webflowPlugin);
      }
    }

    await generateReadme(githubPlugins);
    console.log('Sync process completed.');

    console.log(`Created plugins: ${createdPlugins.length}`);
    console.log(`Updated plugins: ${updatedPlugins.length}`);
    console.log(`Deleted plugins: ${deletedPlugins.length}`);
    console.log(`Failed plugins: ${failedPlugins.length}`);
    if (createdPlugins.length) {
      console.log('Created plugins:', createdPlugins.join(', '));
    }

    if (deletedPlugins.length) {
      console.log('Deleted plugins:', deletedPlugins.join(', '));
    }
    if (failedPlugins.length) {
      console.log('Failed plugins:');
      failedPlugins.forEach((plugin) => {
        console.log(`${plugin.name}: ${plugin.reason}`);
      });
    }
  } catch (error) {
    console.error('An error occurred during the sync process:', error);
    process.exit(1);
  }
};
const commonPartRe =
  /(?:(?:^|-)serverless-plugin(?:-|$))|(?:(?:^|-)serverless(?:-|$))/;

/**
 * Formats the plugin name to title case and removes common parts.
 * @param {string} string - The plugin name.
 * @returns {string} - The formatted plugin name.
 */
function formatPluginName(string) {
  return toTitleCase(
    string.toLowerCase().replace(commonPartRe, '').replace(/-/g, ' '),
  );
}

/**
 * Converts a string to title case.
 * @param {string} str - The input string.
 * @returns {string} - The title-cased string.
 */
function toTitleCase(str) {
  return str.replace(
    /\w\S*/g,
    (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase(),
  );
}

const generateReadme = (plugins) => {
  console.log('Generating README.md');
  const config = {
    transforms: {
      GENERATE_SERVERLESS_PLUGIN_TABLE: function () {
        // Initialize table header
        let md = '| Plugin | Author | Stats |\n';
        md +=
          '|:---------------------------|:-----------|:-------------------------:|\n';

        // Sort and process plugins
        plugins
          .sort((a, b) => {
            const aName = a.name.toLowerCase().replace(commonPartRe, '');
            const bName = b.name.toLowerCase().replace(commonPartRe, '');
            return aName.localeCompare(bName);
          })
          .forEach((data) => {
            const { owner, name: repo } = gitUrlParse(data.githubUrl);
            const repoName = `${owner}/${repo}`;

            // Add plugin details to the table
            md += `| **[${formatPluginName(data.name)} - \`${data.name.toLowerCase()}\`](${data.githubUrl})** <br/> ${data.description} `;
            md += `| [${owner}](https://github.com/${owner}) `;
            md += `| [![GitHub Stars](https://img.shields.io/github/stars/${repoName}.svg?label=Stars&labelColor=black&style=flat&logo=github&logoWidth=8&link=https://github.com/${owner}/${repo})](https://github.com/${owner}/${repo}) <br/> `;
            md += `[![NPM Downloads](https://img.shields.io/npm/dt/${data.name}.svg?label=Downloads&labelColor=black&style=flat&logo=npm&logoWidth=8&link=https://www.npmjs.com/package/${data.name})](https://www.npmjs.com/package/${data.name}) |\n`;
          });

        return md.trim();
      },
    },
  };

  const markdownPath = path.join(__dirname, 'README.md');
  markdownMagic(markdownPath, config, () => {
    console.log('Docs updated!');
  });
};
syncPlugins();
