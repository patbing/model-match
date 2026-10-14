// DOM rendering. All bank text is escaped before insertion.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function formatAnswer(text) {
  let t = esc(text);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\n/g, '<br>');
  return t;
}

function modelName(models, key) {
  const m = models && models.get ? models.get(key) : null;
  return m && m.displayName ? m.displayName : String(key);
}

export function updateHud({ hud, dots, score }, state, total) {
  hud.hidden = false;
  score.textContent = String(state.score);
  dots.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('span');
    d.className = 'dot';
    const r = state.results[i];
    if (r === true) d.classList.add('ok');
    else if (r === false) d.classList.add('no');
    else if (i === state.idx && state.phase !== 'result') d.classList.add('now');
    dots.appendChild(d);
  }
}

export function hideHud({ hud }) {
  hud.hidden = true;
}

export function renderStart(app, { continueAvailable, onDaily, onPractice, onFresh, onContinue }) {
  app.innerHTML = `
  <section class="card">
    <div class="kicker">Guess the model</div>
    <h1>One answer. Four AI models. Who wrote it?</h1>
    <p class="lead">Every answer in this game was pre-generated with the Pollinations API — read the style, spot the tells, and pick the author.</p>
    <ul class="rules">
      <li>5 rounds, one anonymous answer per round</li>
      <li>Correct pick = 100 points, plus +10 / +20 / +30 / +40 for streaks</li>
      <li>Every reveal shows all four answers and each model's style notes</li>
    </ul>
    <div class="actions two">
      <button class="primary" id="btn-daily">Play today's challenge</button>
      <button id="btn-practice">Practice: random rounds</button>
    </div>
    <div class="actions" style="margin-top:10px">
      <button class="ghost" id="btn-fresh">Fresh: live answers (Pollinations connection)</button>
    </div>
    ${continueAvailable ? '<div class="actions" style="margin-top:10px"><button class="ghost" id="btn-continue">Continue saved game</button></div>' : ''}
    <p class="small" style="margin-top:12px">Today's challenge is the same for everyone, every day (UTC). Shared scores show only the pattern — no spoilers. Fresh generates answers live through your Pollinations connection and bills your account; Daily and Practice never call the API.</p>
  </section>`;
  document.getElementById('btn-daily').addEventListener('click', onDaily);
  document.getElementById('btn-practice').addEventListener('click', onPractice);
  const fresh = document.getElementById('btn-fresh');
  if (fresh) fresh.addEventListener('click', onFresh);
  const cont = document.getElementById('btn-continue');
  if (cont) cont.addEventListener('click', onContinue);
}

export function renderRound(app, { round, idx, total, models, selected, onSelect, onConfirm }) {
  app.innerHTML = `
  <section class="card">
    <div class="kicker">Round ${idx + 1} / ${total} · ${esc(round.difficulty)}</div>
    <p class="prompt">Prompt — “${esc(round.promptText)}”</p>
    <div class="answer">${formatAnswer(round.shownText)}</div>
  </section>
  <section class="card">
    <h2>Who wrote this answer?</h2>
    <div class="models" id="models">
      ${round.options.map((k, i) => `
        <button class="choice" data-key="${esc(k)}" aria-pressed="${selected === k}">
          <span class="idx">${'ABCD'[i] || '?'}</span>
          <span>${esc(modelName(models, k))}</span>
        </button>`).join('')}
    </div>
    <div class="actions" style="margin-top:14px">
      <button class="primary" id="btn-confirm" ${selected ? '' : 'disabled'}>Confirm pick</button>
    </div>
  </section>`;
  const chips = [...app.querySelectorAll('button.choice')];
  const confirmBtn = document.getElementById('btn-confirm');
  function applySelection(k) {
    for (const b of chips) b.setAttribute('aria-pressed', String(b.dataset.key === k));
    if (confirmBtn) confirmBtn.disabled = !k;
  }
  if (selected) applySelection(selected);
  for (const b of chips) {
    b.addEventListener('click', () => {
      applySelection(b.dataset.key);
      onSelect(b.dataset.key);
    });
  }
  if (confirmBtn) confirmBtn.addEventListener('click', onConfirm);
}

export function renderReveal(app, { round, models, chosenKey, correct, gained, isLast, idx, total, onNext }) {
  app.innerHTML = `
  <section class="card">
    <div class="kicker">Round ${idx + 1} / ${total} · reveal</div>
    <div class="banner ${correct ? 'good' : 'bad'}">
      ${correct
        ? `Correct! +${gained} points`
        : `Not this time — it was ${esc(modelName(models, round.correctKey))}`}
    </div>
    <h2>All four answers</h2>
    <div class="reveal-list">
      ${round.answers.map((a) => {
        const isAuthor = a.modelKey === round.correctKey;
        const isPick = a.modelKey === chosenKey;
        const m = models && models.get ? models.get(a.modelKey) : null;
        return `
        <div class="reveal-item ${isAuthor ? 'correct' : ''}">
          <div class="who">
            <span class="name">${esc(modelName(models, a.modelKey))}</span>
            <span class="tag">${isAuthor ? '✔ wrote this' : (isPick ? 'your pick' : '')}</span>
          </div>
          <div class="txt">${formatAnswer(a.text)}</div>
          ${isAuthor && m && Array.isArray(m.styleNotes) ? `<ul class="notes">${m.styleNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        </div>`;
      }).join('')}
    </div>
    <p class="small" style="margin-top:10px">Style notes describe tendencies in this answer sample — not fixed traits. Outputs vary with prompt and settings.</p>
    <div class="actions" style="margin-top:8px">
      <button class="primary" id="btn-next">${isLast ? 'See results' : 'Next round'}</button>
    </div>
  </section>`;
  document.getElementById('btn-next').addEventListener('click', onNext);
}

export function renderResult(app, { state, modeLabel, dateLabel, bankLabelText, message, shareBtn, onPractice, onHome }) {
  app.innerHTML = `
  <section class="card center">
    <div class="kicker">${esc(modeLabel)} · ${esc(dateLabel)}</div>
    <div class="result-big">${state.score}<span class="meta-line"> / 600</span></div>
    <div class="pattern">${state.pattern.join('')}</div>
    <p class="meta-line">${esc(message)} · ${esc(bankLabelText)}</p>
    <div class="actions" style="margin-top:14px">
      <button class="primary" id="btn-share">Share result</button>
      <button class="ghost" id="btn-again">Practice again</button>
      <button class="ghost" id="btn-home">Back to start</button>
    </div>
    <div class="share-status" id="share-status"></div>
  </section>`;
  document.getElementById('btn-share').addEventListener('click', shareBtn);
  document.getElementById('btn-again').addEventListener('click', onPractice);
  document.getElementById('btn-home').addEventListener('click', onHome);
}

export function renderFreshSetup(app, {
  notice, connected, storageBlocked, earningsEnabled, busy,
  costKo, costEn, earningsKo, earningsEn,
  onConnect, onStart, onDisconnect, onCancel,
}) {
  app.innerHTML = `
  <section class="card">
    <div class="kicker">Fresh — live answers</div>
    <h1>Play with live AI answers</h1>
    <p class="lead">Fresh reuses bank prompts, but every answer is generated live through your Pollinations connection — one round at a time, 4 requests per round. Connecting opens Pollinations in this tab and returns here automatically.</p>
    <p class="small" id="fresh-store-note"></p>
    <p class="small" id="fresh-cost-ko"></p>
    <p class="small" id="fresh-cost-en"></p>
    <p class="small" id="fresh-earnings-ko" hidden></p>
    <p class="small" id="fresh-earnings-en" hidden></p>
    <p class="small" id="fresh-setup-error" role="alert"></p>
    <div class="actions two" style="margin-top:14px">
      ${connected
        ? '<button class="primary" id="btn-fresh-start">Start Fresh (5 rounds)</button>'
        : '<button class="primary" id="btn-fresh-connect">Connect with Pollinations</button>'}
      ${connected ? '<button class="ghost" id="btn-fresh-disconnect">Disconnect</button>' : ''}
      <button class="ghost" id="btn-fresh-cancel">Back</button>
    </div>
  </section>`;
  document.getElementById('fresh-cost-ko').textContent = costKo;
  document.getElementById('fresh-cost-en').textContent = costEn;
  const earnKo = document.getElementById('fresh-earnings-ko');
  const earnEn = document.getElementById('fresh-earnings-en');
  if (earningsEnabled) {
    earnKo.hidden = false;
    earnEn.hidden = false;
    earnKo.textContent = earningsKo;
    earnEn.textContent = earningsEn;
  }
  document.getElementById('fresh-store-note').textContent = storageBlocked
    ? 'Tab storage is blocked in this browser, so the Pollinations redirect cannot return safely — connection is unavailable here. Daily and Practice still work.'
    : (connected
      ? 'Connected. The key is kept in one sessionStorage item for this tab only. Leaving Fresh keeps it; Disconnect removes it.'
      : 'No key is typed or stored here. Connecting issues a Pollinations key for this tab only.');
  const errEl = document.getElementById('fresh-setup-error');
  if (notice) errEl.textContent = notice;
  const lock = Boolean(busy);
  const connectBtn = document.getElementById('btn-fresh-connect');
  if (connectBtn) {
    connectBtn.disabled = lock || Boolean(storageBlocked);
    connectBtn.addEventListener('click', onConnect);
  }
  const startBtn = document.getElementById('btn-fresh-start');
  if (startBtn) {
    startBtn.disabled = lock;
    startBtn.addEventListener('click', onStart);
  }
  const discBtn = document.getElementById('btn-fresh-disconnect');
  if (discBtn) {
    discBtn.disabled = lock;
    discBtn.addEventListener('click', onDisconnect);
  }
  const cancelBtn = document.getElementById('btn-fresh-cancel');
  if (cancelBtn) {
    cancelBtn.disabled = lock;
    cancelBtn.addEventListener('click', onCancel);
  }
}

export function renderFreshLoading(app, { idx, total, usage, onExit }) {
  app.innerHTML = `
  <section class="card center">
    <div class="kicker">Fresh · Round ${idx + 1} / ${total}</div>
    <h1>Generating 4 live answers…</h1>
    <p class="lead">Guessing is locked until all four answers arrive. Leaving now may still cost you for requests already sent.</p>
    <p class="small" id="fresh-usage"></p>
    <div class="actions" style="margin-top:14px">
      <button class="ghost" id="btn-fresh-exit">Exit Fresh</button>
    </div>
  </section>`;
  setFreshUsage(usage);
  document.getElementById('btn-fresh-exit').addEventListener('click', onExit);
}

export function renderFreshError(app, { title, message, failedNames, usage, retryAfter, onRetry, onExit, terminal, onDisconnect }) {
  const isTerminal = terminal === true;
  app.innerHTML = `
  <section class="card">
    <div class="kicker">Fresh · round paused — not scored</div>
    <h1 id="fresh-err-title"></h1>
    <p class="lead" id="fresh-err-message"></p>
    <p class="small" id="fresh-err-failed"></p>
    <p class="small" id="fresh-usage"></p>
    <div class="actions two" style="margin-top:14px">
      ${isTerminal
        ? '<button class="ghost" id="btn-fresh-disconnect">Disconnect</button>'
        : '<button class="primary" id="btn-fresh-retry">Retry failed answers</button>'}
      <button class="ghost" id="btn-fresh-exit">Exit Fresh</button>
    </div>
  </section>`;
  document.getElementById('fresh-err-title').textContent = title;
  document.getElementById('fresh-err-message').textContent = message;
  document.getElementById('fresh-err-failed').textContent =
    failedNames && failedNames.length
      ? (isTerminal
        ? `Still missing: ${failedNames.join(', ')}. Answers already received are counted below — exiting discards this unplayed round, it is never scored.`
        : `Still missing: ${failedNames.join(', ')}. Answers already received are kept — retry fetches only the missing ones.` +
          (retryAfter !== null && retryAfter !== undefined ? ` The server asked to wait ${retryAfter}s before retrying.` : ''))
      : '';
  setFreshUsage(usage);
  if (!isTerminal) {
    document.getElementById('btn-fresh-retry').addEventListener('click', onRetry);
  } else if (typeof onDisconnect === 'function') {
    document.getElementById('btn-fresh-disconnect').addEventListener('click', onDisconnect);
  }
  document.getElementById('btn-fresh-exit').addEventListener('click', onExit);
}

export function appendFreshUsage(app, usage) {
  const p = document.createElement('p');
  p.className = 'small';
  p.id = 'fresh-usage';
  app.appendChild(p);
  setFreshUsage(usage);
}

export function setFreshUsage(usage) {
  const el = document.getElementById('fresh-usage');
  if (!el) return;
  const u = usage || { requests: 0, succeeded: 0, failed: 0 };
  el.textContent =
    `Fresh API usage — requests: ${u.requests} · succeeded: ${u.succeeded} · failed: ${u.failed} (requests, not charges)`;
}

export function renderError(app, message, onRetry) {
  app.innerHTML = `
  <section class="card">
    <h2>Something went wrong</h2>
    <p class="lead">${esc(message)}</p>
    <div class="actions"><button class="primary" id="btn-retry">Try again</button></div>
  </section>`;
  document.getElementById('btn-retry').addEventListener('click', onRetry);
}

export function setShareStatus(text) {
  const el = document.getElementById('share-status');
  if (el) el.textContent = text;
}
