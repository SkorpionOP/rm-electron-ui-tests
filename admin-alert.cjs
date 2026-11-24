// admin-alert.cjs: Windows popup & toast alert notification system for administrators.
// Triggers an immediate, prominent popup when pipeline tests encounter failures.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Triggers a native Windows GUI Popup to the administrator.
 * Uses PowerShell with System.Windows.Forms.MessageBox (TopMost, Error Icon).
 *
 * @param {Object} options
 * @param {string} options.title - Dialog title
 * @param {string} options.message - Main message text
 * @param {Object} [options.summary] - Summary object (passed, failed, total)
 * @param {Array} [options.failures] - List of failure details
 * @param {string} [options.reportPath] - Path to the generated report
 * @param {boolean} [options.async=true] - Whether to spawn in background without blocking
 */
function sendAdminPopup(options = {}) {
  const {
    title = '⚠️ RM Pipeline Alert: Test Failures Detected',
    summary = null,
    failures = [],
    reportPath = '',
    customMessage = '',
    async = true
  } = options;

  let body = '';
  if (customMessage) {
    body = customMessage;
  } else {
    const time = new Date().toLocaleString();
    const passed = summary ? summary.passCount || summary.passed || 0 : 0;
    const failed = summary ? summary.failCount || summary.failed || failures.length : failures.length;
    const total = summary ? summary.totalTests || (passed + failed) : (passed + failed);

    body += `==============================================\n`;
    body += ` RM APPLICATION AUTOMATED TEST FAILURE ALERT\n`;
    body += `==============================================\n\n`;
    body += `Time: ${time}\n`;
    body += `Status: FAILED (${failed} failure(s) out of ${total} tests)\n`;
    if (summary && summary.failedApps) {
      body += `Failed Apps: ${Array.isArray(summary.failedApps) ? summary.failedApps.join(', ') : summary.failedApps}\n`;
    }
    body += `\n--- FAILURE DETAILS ---\n`;

    if (failures.length > 0) {
      failures.slice(0, 5).forEach((f, idx) => {
        const appPrefix = f.app ? `[${f.app}] ` : '';
        body += `${idx + 1}. ${appPrefix}${f.name || f.testName || 'Test'}\n`;
        if (f.expected || f.actual) {
          body += `   Expected: ${f.expected} | Got: ${f.actual}\n`;
        }
        if (f.error) {
          body += `   Error: ${f.error.substring(0, 100)}\n`;
        }
      });
      if (failures.length > 5) {
        body += `... and ${failures.length - 5} more failures.\n`;
      }
    } else {
      body += `Test execution reported failures. Check report for full details.\n`;
    }

    if (reportPath) {
      body += `\nReport: ${reportPath}\n`;
    }
    body += `\nPlease investigate the RM app and backend logs immediately.`;
  }

  // Escape string for PowerShell string literal
  const escapedMessage = body.replace(/'/g, "''");
  const escapedTitle = title.replace(/'/g, "''");

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$popup = [System.Windows.Forms.MessageBox]::Show(
    '${escapedMessage}',
    '${escapedTitle}',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error,
    [System.Windows.Forms.MessageBoxDefaultButton]::Button1,
    [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly
)
`;

  try {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', psScript
    ], {
      detached: async,
      stdio: async ? 'ignore' : 'inherit',
      windowsHide: false
    });

    if (async) {
      child.unref();
      console.log(`[ADMIN-ALERT] Admin popup dialog dispatched to desktop.`);
    } else {
      return new Promise((resolve) => {
        child.on('exit', () => resolve(true));
      });
    }
  } catch (err) {
    console.error('[ADMIN-ALERT] Failed to launch admin popup dialog:', err.message);
  }

  // Also trigger a Windows Toast / Balloon notification as secondary reinforcement
  triggerWindowsToast(title, `${failures.length} test failure(s) detected across target apps. Check dashboard.`);
}

/**
 * Secondary notification: Windows Notification Toast via PowerShell.
 */
function triggerWindowsToast(title, message) {
  const escapedTitle = title.replace(/'/g, "''");
  const escapedMessage = message.replace(/'/g, "''");

  const toastScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$textNodes = $template.GetElementsByTagName('text')
$textNodes.Item(0).AppendChild($template.CreateTextNode('${escapedTitle}')) > $null
$textNodes.Item(1).AppendChild($template.CreateTextNode('${escapedMessage}')) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('RM Pipeline').Show($toast)
`;

  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-Command', toastScript], {
      detached: true,
      stdio: 'ignore'
    });
    p.unref();
  } catch (e) {
    // Ignore toast error if Windows Runtime is unavailable
  }
}

module.exports = {
  sendAdminPopup,
  triggerWindowsToast
};

// Direct CLI test trigger
if (require.main === module) {
  console.log('Sending test admin popup...');
  sendAdminPopup({
    title: '⚠️ RM Pipeline Test: Simulated Failure Alert',
    summary: {
      totalTests: 28,
      passCount: 26,
      failCount: 2,
      failedApps: ['Microsoft Teams', 'Zoom Workplace']
    },
    failures: [
      { app: 'Microsoft Teams', name: 'Overlay visibility under Teams share', expected: 'alwaysOnTop=true', actual: 'alwaysOnTop=false' },
      { app: 'Zoom Workplace', name: 'Latency TTFT threshold', expected: '< 500ms', actual: '1240ms' }
    ],
    reportPath: path.join(__dirname, 'sample-report', 'report.html'),
    async: true
  });
  console.log('Test admin popup launched successfully.');
}
