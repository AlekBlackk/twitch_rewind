# Twitch Rewind

Chrome extension (MV3) for rewinding a live Twitch stream back to its start, even when the VOD
is not published. It plays the DVR playlist Twitch writes on its CDN during the broadcast
(see `twitch.js` for how the URL is built). If Twitch writes no DVR for a stream, rewind is not available.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick this folder.
3. Open a channel on twitch.tv and click the extension icon: a window with the channel's broadcasts opens
   over the page. Pick one to watch it with chat. Click the icon again or ✕ to close the window; — folds it
   down to its title bar (playback goes on).
   The player has Twitch-style controls: play, volume, seek bar, "В эфир" for a live broadcast, quality
   menu ("Авто" or a fixed quality, remembered) and fullscreen. Keys: ← → seek by 10 seconds, Space or K
   play/pause, M mute, F fullscreen.
   Another channel is opened by typing its name or link into the field at the top of the list;
   matching channels are suggested while typing (Twitch's channel search).
   Drag the title bar to move the window, the bottom-right corner to resize it. The list can be shown
   as tiles or rows, searched by title, filtered by period and sorted.

Broadcasts without a VOD: Twitch has no link to such a stream's DVR once it ends, and its start time cannot be
recovered afterwards. So every channel whose name was typed into the field of the window and sent with "Отслеживать" (not the one opened
from the page) is checked every 5 minutes (while Chrome runs), and
the playlist URL of a live broadcast is saved in `chrome.storage.local` (~300 bytes, no video). After the stream
ends it stays in the list as "сохранён расширением" for as long as Twitch keeps the DVR on its CDN (2+ hours
confirmed, longer not measured); a deleted one disappears from the list. A broadcast that was not seen live
while Chrome was open cannot be saved. Saved broadcasts have no chat.
The watched channels are listed under the toolbar: click a name to open the channel, ✕ stops looking after it
(broadcasts already saved stay in the list). While another channel is open, "← name" returns to the channel of the
Twitch page (it is shown without being watched).

Chat messages show their send time (hover it for the time since the broadcast start) and emotes:
Twitch's own, plus 7TV, BTTV and FFZ (global and the channel's), loaded when the window opens.

Chat: broadcasts with a VOD (also while it is recording) get the full chat replay. Twitch keeps no chat
history for a live broadcast without a VOD: it gets the channel's last ~800 messages from
recent-messages.robotty.de (a third-party service) plus everything sent after the window was opened.

## Test

```
npm test
```
