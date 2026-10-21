import { pollChannels } from "./saved.js";

chrome.action.onClicked.addListener((tab) => {
  if (!tab.url?.startsWith("https://www.twitch.tv/")) return;
  chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["overlay.js"] });
});

// Saving a live broadcast's playlist (see saved.js). Alarms fire only while Chrome runs, which is
// also the only time a stream can be noticed. Registered on every worker start: Chrome may drop alarms.
chrome.alarms.get("poll").then((alarm) => alarm ?? chrome.alarms.create("poll", { periodInMinutes: 5 }));

let polling = null;
const poll = () => (polling ??= pollChannels()
  .catch(() => {}) // Twitch unreachable: the next alarm tries again
  .finally(() => (polling = null)));

chrome.alarms.onAlarm.addListener(poll);
// a newly watched channel is checked at once, not at the next alarm
chrome.storage.onChanged.addListener((changes) => changes.watched && poll());
