function randomJitter(maxJitterMs) {
  if (!maxJitterMs || maxJitterMs <= 0) return 0;
  return Math.floor(Math.random() * maxJitterMs);
}

function startLoop(name, intervalMs, jitterMs, task, logger = console) {
  let stopped = false;
  let running = false;
  let timer = null;

  const schedule = (baseDelay) => {
    if (stopped) return;
    const jitter = randomJitter(jitterMs);
    timer = setTimeout(run, baseDelay + jitter);
  };

  const run = async () => {
    if (stopped) return;

    if (running) {
      schedule(intervalMs);
      return;
    }

    running = true;
    try {
      const result = await task();
      logger.info(`[scheduler:${name}]`, result);
    } catch (err) {
      logger.error(`[scheduler:${name}] failed`, err);
    } finally {
      running = false;
      schedule(intervalMs);
    }
  };

  schedule(1500);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function startScheduler({ config, runOutbound, runInbound, logger = console }) {
  const stopOutbound = startLoop(
    'outbound',
    config.syncOutboundIntervalMs,
    config.syncOutboundJitterMs,
    runOutbound,
    logger
  );

  const stopInbound = startLoop(
    'inbound',
    config.syncInboundIntervalMs,
    config.syncInboundJitterMs,
    runInbound,
    logger
  );

  return () => {
    stopOutbound();
    stopInbound();
  };
}

module.exports = {
  startScheduler
};
