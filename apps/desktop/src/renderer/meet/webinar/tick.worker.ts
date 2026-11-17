// A steady clock for composing the stage: timers in a worker keep their pace while the window is
// in the background (the page's own timers slow to once a second there).
let timer: ReturnType<typeof setInterval> | null = null;
self.onmessage = (e: MessageEvent<number>) => {
  if (timer) clearInterval(timer);
  timer = e.data > 0 ? setInterval(() => self.postMessage(0), e.data) : null;
};
