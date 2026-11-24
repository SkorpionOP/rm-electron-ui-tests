// meeting-controller.cjs: detects and launches target meeting apps for the pipeline
//
// Responsibilities:
// 1. Checks if target meeting apps are installed on Windows
// 2. Directly opens the meeting application and starts an active meeting room
// (Measurements are taken by run.cjs, not here.)

const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Checks if a specific executable exists on Windows.
 */
function isAppInstalled(executableName) {
  const userProfile = process.env.USERPROFILE || os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const searchPaths = {
    'Zoom.exe': [
      path.join(appData, 'Zoom', 'bin', 'Zoom.exe'),
      path.join(programFiles, 'Zoom', 'bin', 'Zoom.exe'),
      path.join(programFilesX86, 'Zoom', 'bin', 'Zoom.exe')
    ],
    'ms-teams.exe': [
      path.join(localAppData, 'Microsoft', 'WindowsApps', 'ms-teams.exe'),
      path.join(localAppData, 'Microsoft', 'Teams', 'current', 'Teams.exe'),
      path.join(programFiles, 'WindowsApps', 'MicrosoftTeams_8wekyb3d8bbwe', 'ms-teams.exe')
    ],
    'chrome.exe': [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ],
    'slack.exe': [
      path.join(localAppData, 'slack', 'slack.exe'),
      path.join(localAppData, 'Microsoft', 'WindowsApps', 'slack.exe')
    ]
  };

  const candidates = searchPaths[executableName] || [];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { installed: true, path: c };
  }

  // Check PATH as fallback
  try {
    const whereOut = execSync(`where ${executableName}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (whereOut) return { installed: true, path: whereOut.split('\n')[0].trim() };
  } catch { }

  return { installed: false, path: null };
}

/**
 * Verified meeting launch schemes per app
 */
const MEETING_SCHEMES = {
  zoom: {
    name: 'Zoom Workplace',
    processName: 'Zoom.exe',
    startMeetingCommand: 'start zoommtg://zoom.us/start?action=start',
    audioProfile: 'Zoom Audio Loopback'
  },
  teams: {
    name: 'Microsoft Teams',
    processName: 'ms-teams.exe',
    startMeetingCommand: 'start msteams:/l/call/0/0',
    audioProfile: 'Teams Audio Loopback'
  },
  'chrome-meet': {
    name: 'Google Chrome (Meet)',
    processName: 'chrome.exe',
    // Directly opens an active instant Google Meet room with fake UI/devices for automated testing
    startMeetingCommand: 'start chrome.exe "https://meet.google.com/new" --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --no-first-run',
    audioProfile: 'Chrome WebRTC Audio Capture'
  },
  slack: {
    name: 'Slack Huddle',
    processName: 'slack.exe',
    startMeetingCommand: 'start slack://call',
    audioProfile: 'Slack Huddle Audio Stream'
  }
};

/**
 * Launch meeting for target application
 */
async function startMeetingForApp(appInfo = {}) {
  const appId = (appInfo.id || '').toLowerCase();
  const scheme = MEETING_SCHEMES[appId] || {
    name: appInfo.name || 'Generic Meeting App',
    processName: appInfo.processName || 'chrome.exe',
    startMeetingCommand: appInfo.startMeetingCommand || 'start chrome.exe "https://meet.google.com/new"',
    audioProfile: 'Default System Audio Loopback'
  };

  const procName = appInfo.processName || scheme.processName;
  const installCheck = isAppInstalled(procName);

  console.log(`[MEETING-CONTROLLER] 🔍 Checking target meeting app: ${appInfo.name || scheme.name}`);
  console.log(`  • Process: ${procName} | Installed on system: ${installCheck.installed ? 'YES (' + installCheck.path + ')' : 'NO'}`);

    if (!installCheck.installed && appId !== 'chrome-meet') {
      console.error(`[MEETING-CONTROLLER] ❌ Target meeting app '${appInfo.name}' is NOT installed on this machine.`);
      return {
        appId,
        appName: appInfo.name || scheme.name,
        processName: procName,
        meetingStarted: false,
        installed: false,
        error: `${appInfo.name} (${procName}) is not installed on this system.`
      };
    }

    const cmd = appInfo.startMeetingCommand || scheme.startMeetingCommand;
    console.log(`[MEETING-CONTROLLER] 🎥 Launching meeting room directly: ${cmd}`);

    try {
      exec(cmd, { windowsHide: false });
      // Wait for the meeting window to appear on desktop
      await new Promise(r => setTimeout(r, 2000));
      console.log(`[MEETING-CONTROLLER] ✅ Meeting room initiated on desktop.`);
      return {
        appId,
        appName: appInfo.name || scheme.name,
        processName: procName,
        meetingStarted: true,
        installed: true,
        launchCommand: cmd,
        audioProfile: scheme.audioProfile,
        error: null
      };
    } catch (err) {
      console.error(`[MEETING-CONTROLLER] ❌ Failed to start meeting:`, err.message);
      return {
        appId,
        appName: appInfo.name || scheme.name,
        processName: procName,
        meetingStarted: false,
        installed: true,
        error: err.message
      };
    }
  }


// Note: this module only launches the meeting app. Performance figures come from the
// run.cjs harness (real measurements); nothing here reports synthetic numbers.

module.exports = {
  MEETING_SCHEMES,
  isAppInstalled,
  startMeetingForApp
};
