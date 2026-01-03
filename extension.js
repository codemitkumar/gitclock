const fs = require("fs");
const { exec } = require("child_process");
const path = require("path");
const vscode = require("vscode");
const http = require("http");
const querystring = require("querystring");
const axios = require("axios");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const AUTH_URL = process.env.AUTH_URL;
const TOKEN_URL = process.env.TOKEN_URL;
const REDIRECT_URI = process.env.REDIRECT_URI;
const GITHUB_API_URL = process.env.GITHUB_API_URL;
const REPO_NAME = process.env.REPO_NAME;
/**
 * @param {vscode.ExtensionContext} context
 */


const githubHeaders = (token) => ({
  Authorization: `token ${token}`,
  Accept: "application/vnd.github+json",
});
async function handleRepoAndChangelog(accessToken, changedFiles) {
  try {
    const userResponse = await axios.get(`${GITHUB_API_URL}/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const username = userResponse.data.login;
    const today = new Date().toISOString().split("T")[0]; // Format: YYYY-MM-DD
    const changelogFileName = `CHANGELOG_${today}.md`;

    let contentsResponse;
    try {
      contentsResponse = await axios.get(
        `${GITHUB_API_URL}/repos/${username}/${REPO_NAME}/contents`,
        {
          headers: githubHeaders(accessToken)
          ,
        }
      );
    } catch (error) {
      if (error.response && error.response.status === 404) {
        const newContent = generateChangelogContent(changedFiles);
        const base64NewContent = Buffer.from(newContent).toString("base64");

        await createFile(accessToken, username, changelogFileName, base64NewContent);
        return;
      } else {
        throw error;
      }
    }

    const changelogFile = contentsResponse.data.find(
      (file) => file.name === changelogFileName
    );

    const changesList = changedFiles
      .map(
        (file) =>
          `| ${new Date().toLocaleString()} | ${file.fileName} | ${file.additions
          } Additions & ${file.deletions} Deletions|`
      )
      .join("\n");

    if (changelogFile) {
      const changelogContentResponse = await axios.get(changelogFile.download_url);
      const changelogContent = changelogContentResponse.data;
      const updatedContent = appendToTable(changelogContent, changesList);
      const base64UpdatedContent =
        Buffer.from(updatedContent).toString("base64");

      await updateFile(accessToken, username, changelogFile, base64UpdatedContent);
    } else {
      const newContent = generateChangelogContent(changedFiles);
      const base64NewContent = Buffer.from(newContent).toString("base64");

      await createFile(accessToken, username, changelogFileName, base64NewContent);
    }

    vscode.window.showInformationMessage(`Changes pushed to Repository`);
  } catch (error) {
    vscode.window.showErrorMessage(
      "Error handling repository and CHANGELOG: " + error.message
    );
  }
}

function appendToTable(existingContent, newChanges) {
  const tableRegex = /\| Time \(UTC\)[\s\S]*?\n(\|[-]+.*?\n)?([\s\S]*?)\n$/;
  const match = tableRegex.exec(existingContent);

  if (match) {
    const existingTable = match[2] || "";
    const updatedTable = `${existingTable.trim()}\n${newChanges.trim()}`;
    return existingContent.replace(match[2], updatedTable);
  } else {
    return (
      existingContent +
      `\n| Time (UTC)             | Files Modified                    | Changes (Addition/Deletion) |\n|------------------------|-----------------------------------|-----------------------------|\n${newChanges}`
    );
  }
}

function generateChangelogContent(changedFiles) {
  const changesList = changedFiles
    .map(
      (file) =>
        `| ${new Date().toLocaleString()} | ${file.fileName} | ${file.additions
        } Additions & ${file.deletions} Deletions |`
    )
    .join("\n");

  return `# Daily Changelog

This file logs the changes made on ${new Date().toLocaleDateString()}.

| Time (UTC)             | Files Modified                    | Changes (Addition/Deletion) |
|------------------------|-----------------------------------|-----------------------------|
${changesList}
`;
}
async function updateFile(accessToken, username, file, content) {
  try {
    await axios.put(
      `${GITHUB_API_URL}/repos/${username}/${REPO_NAME}/contents/${file.path}`,
      {
        message: `Update ${file.name} with change log`,
        content: content,
        sha: file.sha,
      },
      {
        headers: githubHeaders(accessToken)
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error updating ${file.name}: ` + error.message
    );
  }
}

async function createFile(accessToken, username, fileName, content) {
  try {
    await axios.put(
      `${GITHUB_API_URL}/repos/${username}/${REPO_NAME}/contents/${fileName}`,
      {
        message: `Create ${fileName} with initial content`,
        content: content,
      },
      {
        headers: githubHeaders(accessToken)
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error creating ${fileName}: ` + error.message
    );
  }
}

async function activate(context) {
  const disposable = vscode.commands.registerCommand(
    "gitclock.startOAuth",
    async function () {
      try {
        const { default: open } = await import("open");

        // ✅ BUILD AUTH URL CORRECTLY
        const authUrl =
          `${AUTH_URL}` +
          `?client_id=${CLIENT_ID}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
          `&scope=repo%20user`;

        vscode.window.showInformationMessage("Opening GitHub login page...");
        open(authUrl); // ✅ THIS WILL NOT 404

        const server = http.createServer(async (req, res) => {
          if (req.url.startsWith("/oauthCallback")) {
            const queryParams = querystring.parse(req.url.split("?")[1]);
            const code = queryParams.code;

            if (!code) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Error: No code received.");
              return;
            }

            try {
              const tokenResponse = await axios.post(
                TOKEN_URL,
                {
                  client_id: CLIENT_ID,
                  client_secret: CLIENT_SECRET,
                  code,
                  redirect_uri: REDIRECT_URI,
                },
                { headers: { Accept: "application/json" } }
              );

              const accessToken = tokenResponse.data.access_token;

              if (accessToken) {
                vscode.window.showInformationMessage("GitHub login successful!");
                context.globalState.update("githubAccessToken", accessToken);
                checkAndCreateRepo(accessToken);
              } else {
                vscode.window.showErrorMessage("Failed to obtain access token.");
              }
            } catch (error) {
              vscode.window.showErrorMessage(
                "Error exchanging code for token: " + error.message
              );
            }

            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("You can close this window and return to VS Code.");
            server.close();
          }
        });

        server.listen(5000);
      } catch (error) {
        vscode.window.showErrorMessage(
          "Error starting OAuth flow: " + error.message
        );
      }
    }
  );
  const runNowDisposable = vscode.commands.registerCommand(
    "gitclock.runNow",
    async function () {
      const accessToken = context.globalState.get("githubAccessToken");

      if (!accessToken) {
        vscode.window.showErrorMessage(
          "You are not authenticated. Run GitClock: Authenticate first."
        );
        return;
      }

      vscode.window.showInformationMessage("Running GitClock sync now...");
      await runSyncOnce(accessToken);
    }
  );

  context.subscriptions.push(runNowDisposable);

  context.subscriptions.push(disposable);

  const accessToken = context.globalState.get("githubAccessToken");
  if (accessToken) {
    checkAndCreateRepo(accessToken);
    monitorFileChanges(accessToken);
  }
}

async function runSyncOnce(accessToken) {
  const currentWorkingDir =
    vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;

  if (!currentWorkingDir) {
    vscode.window.showErrorMessage("No workspace folder found.");
    return;
  }

  exec(
    "git status --short",
    { cwd: currentWorkingDir },
    async (error, stdout) => {
      if (error || stdout.trim() === "") {
        vscode.window.showInformationMessage("No changes to sync.");
        if (error) {
          vscode.window.showErrorMessage("Error executing git command: " + error.message);
        }
        return;
      }

      const changedFiles = (
        await Promise.all(
          stdout
            .split("\n")
            .filter(Boolean)
            .map(async (line) => {
              const match = line.match(/^(.{2})\s+(.*)$/);
              if (!match) return null;

              const status = match[1].trim();
              const fileName = match[2].trim();

              if (status === "??") {
                return { fileName, additions: 0, deletions: 0, status: "Untracked" };
              } else if (status === "M" || status === "A" || status === "D") {
                const diff = await getDiffStats(cwd, fileName);
                return { fileName, ...diff, status };
              } else {
                return { fileName, additions: 0, deletions: 0, status };
              }
            })
        )
      ).filter(Boolean);

      if (changedFiles.length === 0) return;


      await handleRepoAndChangelog(accessToken, changedFiles);
      vscode.window.showInformationMessage("GitClock sync completed.");
    }
  );
}

async function monitorFileChanges(accessToken) {
  const currentWorkingDir = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;

  if (!currentWorkingDir) {
    return;
  }


  setInterval(async () => {
    exec(
      "git status --short",
      { cwd: currentWorkingDir },
      async (error, stdout) => {
        if (error) {
          return;
        }

        if (stdout.trim() === "") {
          return;
        }

        const changedFiles = (
          await Promise.all(
            stdout
              .split("\n")
              .filter(Boolean)
              .map(async (line) => {
                const match = line.match(/^(.{2})\s+(.*)$/);
                if (!match) return null;

                const status = match[1].trim();
                const fileName = match[2].trim();

                if (status === "??") {
                  return { fileName, additions: 0, deletions: 0, status: "Untracked" };
                } else if (status === "M" || status === "A" || status === "D") {
                  const diff = await getDiffStats(cwd, fileName);
                  return { fileName, ...diff, status };
                } else {
                  return { fileName, additions: 0, deletions: 0, status };
                }
              })
          )
        ).filter(Boolean);

        if (changedFiles.length === 0) return;



        try {
          await handleRepoAndChangelog(accessToken, changedFiles);
          vscode.window.showInformationMessage("Changes logged successfully!");
        } catch (err) {
        }
      }
    );
  }, 2 * 60 * 1000);
}

function getDiffStats(cwd, fileName) {
  return new Promise((resolve) => {
    exec(`git diff --numstat -- "${fileName}"`, { cwd }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve({ additions: undefined, deletions: undefined });
        return;
      }

      const [additions, deletions] = stdout.trim().split("\t");
      resolve({
        additions: parseInt(additions, 10),
        deletions: parseInt(deletions, 10),
      });
    });
  });
}

async function checkAndCreateRepo(accessToken) {
  try {
    const userResponse = await axios.get(`${GITHUB_API_URL}/user`, {
      headers: githubHeaders(token),
    });
    const username = userResponse.data.login;

    try {
      await axios.get(
        `${GITHUB_API_URL}/repos/${username}/${REPO_NAME}`,
        { headers: githubHeaders(token) }
      );
    } catch {
      await axios.post(
        `${GITHUB_API_URL}/user/repos`,
        { name: REPO_NAME, private: false },
        { headers: githubHeaders(token) }
      );
      await createRepo(accessToken);
      await createReadmeFile(accessToken, username);
    }

  } catch (error) {
    if (error.response && error.response.status === 404) {
      vscode.window.showErrorMessage(
        "Authentication failed or repository creation failed."
      );
    }
  }
}

async function createRepo(accessToken) {
  try {
    const createRepoResponse = await axios.post(
      `${GITHUB_API_URL}/user/repos`,
      {
        name: REPO_NAME,
        private: false,
      },
      {
        headers: githubHeaders(accessToken),
      }
    );

    if (createRepoResponse.status === 201) {
      vscode.window.showInformationMessage(
        `Repository "${REPO_NAME}" created successfully.`
      );
    } else {
      vscode.window.showErrorMessage("Failed to create repository.");
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      "Error creating repository: " + error.message
    );
  }
}

async function createReadmeFile(accessToken, username) {
  try {
    const readmeContent = `# Git Clock

GitClock is an automation extension for Visual Studio Code that ensures your GitHub contributions remain active

![Extension Logo](https://raw.githubusercontent.com/author-sanjay/gitclock/master/logo.jpeg)

## Features

- **Automatic Commit Every 30 Minutes**: The extension automatically commits changes every 30 minutes to ensure that your work is regularly logged on main branch so that your git contribution is counted.
- **Sync Logs in Main Branch**: All your sync logs are stored in the \`main\` branch, ensuring that your contributions are tracked, even if you're working on a different branch.
- **Keeps Track of Your Hard Work**: By syncing your changes to the main branch, your contributions are always counted in the repository history, providing visibility of your continuous progress.
- **Works on Any Branch**: No need to worry about not being on the main branch. \`gitClock\` ensures your work is recorded regardless of the branch you're working on.
- **Customizable Commit Messages**: The commit messages are automatically generated to reflect the time and sync details, making your commit history clean and organized.
- **Lightweight and Simple**: The extension works quietly in the background without interrupting your workflow, only committing changes when necessary.

## Installation
1. **Manually:**
   - Download the \`.vsix\` file from  https://open-vsx.org/extension/authorSanju/gitclock.
   - In Visual Studio Code, go to the Extensions view.
   - Click the three dots on the top right and select **Install from VSIX**.
   - Browse and select the \`.vsix\` file.

2. **VS Code:**
    - We are trying to get our extension on VS code Marketplace

## Usage
1. After installation, activate the extension via the **Command Palette** (\`Ctrl+Shift+P\` / \`Cmd+Shift+P\`).
2. Search for \`GitClock: Authenticate\` and select it to authenticate the extension with the profile where you want your contributions to be counted.

## Contributing
- Fork the repository.
- Clone your fork: git clone https://github.com/your-username/your-extension-name.git
- Install dependencies: npm install
- Make your changes.
- Test extension
- Commit and push your changes.
- Create a pull request with a description of what you've changed.

## License
This extension is licensed under the MIT License. See LICENSE for more details.
`;

    const base64Content = Buffer.from(readmeContent).toString("base64");

    await axios.put(
      `${GITHUB_API_URL}/repos/${username}/${REPO_NAME}/contents/README.md`,
      {
        message: "Add initial README.md",
        content: base64Content,
      },
      {
        headers: githubHeaders(accessToken),
      }
    );

    vscode.window.showInformationMessage(
      `README.md added to repository "${REPO_NAME}" successfully.`
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      "Error creating README.md: " + error.message
    );
  }
}

function deactivate() {
  console.log("GitClock extension deactivated.");
}

module.exports = {
  activate,
  deactivate,
};
