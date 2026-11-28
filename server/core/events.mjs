import { EventEmitter } from 'node:events';

/**
 * Global event bus. The HTTP layer forwards every event to SSE clients.
 * Event shape: { type, ts, ...payload }
 * Progress events use: { type:'progress', taskId, scope, label, done, total, bytes, totalBytes, phase }
 */
class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.history = [];
  }

  emitEvent(evt) {
    const e = { ts: Date.now(), ...evt };
    this.history.push(e);
    if (this.history.length > 400) this.history.splice(0, this.history.length - 400);
    this.emit('event', e);
    return e;
  }

  progress(payload) {
    return this.emitEvent({ type: 'progress', ...payload });
  }

  log(level, message, extra = {}) {
    return this.emitEvent({ type: 'log', level, message: String(message), ...extra });
  }

  notify(kind, title, message = '', extra = {}) {
    return this.emitEvent({ type: 'notify', kind, title, message, ...extra });
  }

  /** Create a task-scoped progress helper. */
  task(taskId, scope, label, total = 0) {
    const self = this;
    return {
      taskId, scope,
      update(patch = {}) {
        self.progress({ taskId, scope, label, total, ...patch });
      },
      done(extra = {}) {
        self.progress({ taskId, scope, label, done: 1, total: 1, finished: true, ok: true, ...extra });
      },
      fail(message) {
        self.progress({ taskId, scope, label, finished: true, ok: false, error: String(message && message.message || message) });
      },
    };
  }
}

export const bus = new Bus();
