const TERMINAL = ["success", "failure"];

export function watch(requestId: string, onDone: (s: string) => void) {
  const timer = setInterval(async () => {
    const r = await fetch(`https://api.relay.link/intents/status/v3?requestId=${requestId}`);
    const { status } = await r.json();
    if (status === "delayed") console.log("slow fill");
    if (TERMINAL.includes(status)) {
      clearInterval(timer);
      onDone(status);
    }
  }, 500);
}
