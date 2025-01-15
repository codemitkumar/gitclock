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
const MIN_COMMIT_INTERVAL = 30;
let commitInterval = MIN_COMMIT_INTERVAL * 60 * 1000; 

async function handleRepoAndChangelog(accessToken, changedFiles) {
  try {
    const userResponse = await axios.get(`${GITHUB_API_URL}/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const username = userResponse.data.login;
    const today = new Date().toISOString().split("T")[0];
    const changelogFileName = `CHANGELOG_${today}.md`;

    let contentsResponse;
    try {
      contentsResponse = await axios.get(
        `${GITHUB_API_URL}/repos/${username}/${REPO_NAME}/contents`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
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
          `| ${new Date().toLocaleString()} | ${file.fileName} | ${
            file.additions
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
        `| ${new Date().toLocaleString()} | ${file.fileName} | ${
          file.additions
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
        headers: { Authorization: `Bearer ${accessToken}` },
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
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error creating ${fileName}: ` + error.message
    );
  }
}

async function activate(context) {
  const setIntervalCommand = vscode.commands.registerCommand(
    'gitclock.setCommitInterval',
    async () => {
      const input = await vscode.window.showInputBox({
        prompt: `Enter commit interval in minutes (minimum ${MIN_COMMIT_INTERVAL} minutes)`,
        value: String(commitInterval / (60 * 1000)), 
        validateInput: (value) => {
          const num = parseInt(value);
          if (isNaN(num) || !Number.isInteger(num)) {
            return 'Please enter a valid number';
          }
          if (num < MIN_COMMIT_INTERVAL) {
            return `Commit interval cannot be less than ${MIN_COMMIT_INTERVAL} minutes`;
          }
          return null; 
        }
      });
      
      if (input) {
        const newInterval = parseInt(input);
        if (newInterval >= MIN_COMMIT_INTERVAL) {
          commitInterval = newInterval * 60 * 1000;
          vscode.window.showInformationMessage(
            `Commit interval set to ${newInterval} minutes`
          );
          
          context.globalState.update('gitClockCommitInterval', commitInterval);
        }
      }
    }
  );
  
  context.subscriptions.push(setIntervalCommand);

  const savedInterval = context.globalState.get('gitClockCommitInterval');
  if (savedInterval && savedInterval >= MIN_COMMIT_INTERVAL * 60 * 1000) {
    commitInterval = savedInterval;
  }

  const disposable = vscode.commands.registerCommand(
    "gitclock.startOAuth",
    async function () {
      try {
        const { default: open } = await import("open");
        vscode.window.showInformationMessage("Opening GitHub login page...");
        open(AUTH_URL);
        
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
                  code: code,
                  redirect_uri: REDIRECT_URI,
                },
                { headers: { Accept: "application/json" } }
              );

              const accessToken = tokenResponse.data.access_token;

              if (accessToken) {
                vscode.window.showInformationMessage(
                  "GitHub login successful!"
                );
                context.globalState.update("githubAccessToken", accessToken);
                checkAndCreateRepo(accessToken);
              } else {
                vscode.window.showErrorMessage(
                  "Failed to obtain access token."
                );
              }
            } catch (error) {
              vscode.window.showErrorMessage(
                "Error exchanging code for token: " + error.message
              );
            }

            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("You can close this window and return to VS Code.");
            server.close();
          } else {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
          }
        });

        server.listen(5000, () => {
        });
      } catch (error) {
        vscode.window.showErrorMessage(
          "Error starting OAuth flow: " + error.message
        );
      }
    }
  );

  context.subscriptions.push(disposable);

  const accessToken = context.globalState.get("githubAccessToken");
  
  if (!accessToken) {
    vscode.window.showErrorMessage(
      "You are not authenticated. Please log in using GitHub."
    );
  } else {
    await checkAndCreateRepo(accessToken);
    
    const stopMonitoring = await monitorFileChanges(accessToken);
    
    context.subscriptions.push({
      dispose: () => {
        if (stopMonitoring) {
          stopMonitoring();
        }
      }
    });
  }
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

        const changedFiles = await Promise.all(
          stdout
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map(async (line) => {
              const [status, ...fileParts] = line.trim().split(/\s+/);
              const fileName = fileParts.join(" "); 

              if (status === "??") {
                return {
                  status: "New file (untracked)",
                  fileName,
                  additions: 0,
                  deletions: 0,
                };
              } else if (status === "M") {
                const diffResult = await getDiffStats(
                  currentWorkingDir,
                  fileName
                );
                return { status: "Modified", fileName, ...diffResult };
              } else {
                return { status, fileName, additions: 0, deletions: 0 };
              }
            })
        );

        try {
          await handleRepoAndChangelog(accessToken, changedFiles);
          vscode.window.showInformationMessage("Changes logged successfully!");
        } catch (err) {
        }
      }
    );
  }, commitInterval);
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
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const username = userResponse.data.login;

    try {
      const reposResponse = await axios.get(`${GITHUB_API_URL}/user/repos`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const repoExists = reposResponse.data.some(
        (repo) => repo.name === REPO_NAME
      );

      if (repoExists) {
        vscode.window.showInformationMessage(
          `Repository "${REPO_NAME}" exists.`
        );
      } else {
        await createRepo(accessToken);
        await createReadmeFile(accessToken, username);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        "Error checking repository: " +
          (error.response ? error.response.data.message : error.message)
      );
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
        headers: { Authorization: `Bearer ${accessToken}` },
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

- **Customizable Commit Intervals**: Set your preferred commit interval through VS Code commands.
- **Automatic Commit**: The extension automatically commits changes based on your set interval to ensure that your work is regularly logged on main branch.
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
3. (Optional) Use \`GitClock: Set Commit Interval\` to customize how often changes are committed.

## Contributing
- Fork the repository
- Clone your fork: git clone https://github.com/your-username/your-extension-name.git
- Install dependencies: npm install
- Make your changes
- Test extension
- Commit and push your changes
- Create a pull request with a description of what you've changed

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
        headers: { Authorization: `Bearer ${accessToken}` },
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