// Injected into the Twitch tab on each icon click: toggles the player window over the page.
// The window's title bar and resize grip live inside the iframe; it sends move/resize/minimize/close
// messages here. Wrapped in a block so re-injection does not redeclare top-level names.
{
  const existing = document.getElementById("twitch-rewind");
  if (existing) {
    existing.remove();
  } else {
    const channel = location.pathname.split("/")[1] ?? "";
    const frame = document.createElement("iframe");
    frame.id = "twitch-rewind";
    frame.src = chrome.runtime.getURL(`player.html?channel=${encodeURIComponent(channel)}`);
    frame.allow = "autoplay; fullscreen";

    const MIN_WIDTH = 480;
    const MIN_HEIGHT = 320;
    const bounds = {
      width: Math.min(1400, innerWidth * 0.94),
      height: Math.min(820, innerHeight * 0.86),
    };
    bounds.left = (innerWidth - bounds.width) / 2;
    bounds.top = 60;
    let collapsedHeight = null; // height of the bare title bar while minimized; `bounds.height` is kept for restoring

    const applyBounds = () => {
      for (const key of ["left", "top", "width"]) frame.style[key] = `${bounds[key]}px`;
      frame.style.height = `${collapsedHeight ?? bounds.height}px`;
    };
    Object.assign(frame.style, {
      position: "fixed",
      border: "1px solid #3a3a3d",
      borderRadius: "8px",
      boxShadow: "0 8px 32px #000a",
      zIndex: "2147483647",
    });
    applyBounds();
    document.body.append(frame);

    const extensionOrigin = new URL(frame.src).origin;
    addEventListener("message", function onMessage({ origin, data }) {
      if (origin !== extensionOrigin || data?.type !== "twitch-rewind") return;
      if (data.action === "close" || !frame.isConnected) {
        frame.remove();
        removeEventListener("message", onMessage);
      } else if (data.action === "move") {
        // keep the title bar reachable
        bounds.left = Math.min(Math.max(bounds.left + data.dx, 100 - bounds.width), innerWidth - 100);
        bounds.top = Math.min(Math.max(bounds.top + data.dy, 0), innerHeight - 40);
      } else if (data.action === "resize") {
        bounds.width = Math.max(MIN_WIDTH, bounds.width + data.dx);
        bounds.height = Math.max(MIN_HEIGHT, bounds.height + data.dy);
      } else if (data.action === "minimize") {
        collapsedHeight = data.height; // null restores
      }
      applyBounds();
    });
  }
}
