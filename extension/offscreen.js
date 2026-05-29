// Service workers can't access navigator.clipboard in MV3, so we route
// clipboard writes through this offscreen document, which has a real
// document/window context.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.target === 'offscreen' && msg.type === 'copy-to-clipboard') {
    (async () => {
      try {
        await navigator.clipboard.writeText(msg.text);
        sendResponse({ ok: true });
      } catch (err) {
        // Fallback: hidden textarea + execCommand. Works in offscreen docs
        // where the async clipboard API rejects for lack of focus.
        try {
          const ta = document.createElement('textarea');
          ta.value = msg.text;
          ta.style.position = 'fixed';
          ta.style.left = '-99999px';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          if (ok) sendResponse({ ok: true });
          else sendResponse({ ok: false, error: String((err && err.message) || err) });
        } catch (err2) {
          sendResponse({ ok: false, error: String((err2 && err2.message) || err2) });
        }
      }
    })();
    return true; // async response
  }
});
