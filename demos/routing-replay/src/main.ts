import { ReplayDataSchema } from "./contracts.ts";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("missing app");

const response = await fetch("./data/replay.json");
const raw: unknown = await response.json();
const data = ReplayDataSchema.parse(raw);
const durationMs = 12_000;
const stageCount = 10;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let progress = reducedMotion ? 1 : 0;
let playing = !reducedMotion;
let previous = performance.now();
const eligibleProfiles = data.profiles.filter((profile) => profile.eligible);

app.innerHTML = `<main class="page">
  <div class="eyebrow">JEV / ROUTING REPLAY <span>${data.label}</span></div>
  <section class="terminal" aria-label="Illustrative Jev routing replay">
    <header class="chrome">
      <div aria-hidden="true"><i></i><i></i><i></i></div>
      <span>main session / task_route</span>
      <b id="phase"></b>
    </header>
    <div class="screen" aria-live="polite">
      <div id="scan" class="scan" aria-hidden="true"></div>
      <div class="line" data-stage="0"><span class="prompt">&gt;</span> ${data.task.title}</div>
      <div class="line" data-stage="1"><span class="bullet">●</span> Main session <em>plans the work</em></div>
      <div class="line" data-stage="2"><span class="bullet amber">●</span> Host decides to delegate <small>host-owned decision</small></div>
      <div class="brief" data-stage="3"><small>APPROVED BRIEF</small><p>${data.task.briefing}</p><b>requires: ${data.task.requiredCapability}</b></div>
      <div class="line" data-stage="4"><span class="bullet cyan">●</span> task_route <em>filters the trusted registry</em></div>
      <div class="candidate-block" data-stage="5">${eligibleProfiles
        .map(
          (profile) =>
            `<div class="candidate" data-id="${profile.profileId}"><span>${profile.profileId}</span><small>${profile.effort} · ${profile.role}</small>${profile.profileId === data.selection.profileId ? "<b>SELECTED</b>" : ""}</div>`,
        )
        .join("")}</div>
      <div class="line annotation" data-stage="5">↳ eligibility comes from host policy and registered capabilities</div>
      <div class="line" data-stage="6"><span class="bullet green">●</span> Jev selects <strong>${data.selection.profileId}</strong></div>
      <div class="line" data-stage="7"><span class="bullet amber">●</span> Host launches its registered profile <small>Jev does not execute the worker</small></div>
      <div class="line" data-stage="8"><span class="bullet green">●</span> Simulated worker result <strong>returns to the same main session</strong></div>
      <div class="final" data-stage="9"><small>HOST VERIFICATION</small><p>${data.simulatedResult.summary}</p></div>
    </div>
    <footer class="statusbar"><span id="status"></span><span>${data.notice}</span></footer>
  </section>
  <div class="controls">
    <button id="play" type="button"></button>
    <button id="replay" type="button">replay</button>
    <div class="progress" aria-hidden="true"><i id="progress"></i></div>
    <a href="./data/replay.json" download>replay.json</a>
  </div>
  <p class="credit">Visual rhythm inspired by <a href="https://x.com/tamarajtran/status/2100694549362553153">Tamara Tran's JevDemo</a></p>
</main>`;

const byId = <ElementType extends HTMLElement>(id: string) =>
  document.querySelector<ElementType>(`#${id}`);

function update(): void {
  const stage = Math.min(stageCount - 1, Math.floor(progress * stageCount));
  document.querySelectorAll<HTMLElement>("[data-stage]").forEach((row) => {
    row.classList.toggle("visible", stage >= Number(row.dataset.stage));
  });
  document.querySelectorAll<HTMLElement>(".candidate").forEach((row) => {
    const selected = row.dataset.id === data.selection.profileId;
    row.classList.toggle("selected", stage >= 6 && selected);
    row.classList.toggle("unselected", stage >= 6 && !selected);
  });
  const scan = byId<HTMLElement>("scan");
  if (scan) {
    scan.style.opacity = stage === 5 && !reducedMotion ? "1" : "0";
    scan.style.transform = `translateY(${Math.max(0, Math.min(170, (progress * stageCount - 5) * 170))}px)`;
  }
  const phase = byId<HTMLElement>("phase");
  if (phase) phase.textContent = `${stage + 1}/${stageCount}`;
  const bar = byId<HTMLElement>("progress");
  if (bar) bar.style.transform = `scaleX(${progress})`;
  const status = byId<HTMLElement>("status");
  if (status) status.textContent = playing ? "playing" : progress >= 1 ? "complete" : "paused";
  const play = byId<HTMLButtonElement>("play");
  if (play) play.textContent = playing ? "pause" : "play";
}

byId<HTMLButtonElement>("play")?.addEventListener("click", () => {
  if (progress >= 1) progress = 0;
  playing = !playing;
  previous = performance.now();
  update();
});

byId<HTMLButtonElement>("replay")?.addEventListener("click", () => {
  progress = 0;
  playing = true;
  previous = performance.now();
  update();
});

function frame(now: number): void {
  if (playing) {
    progress = Math.min(1, progress + (now - previous) / durationMs);
    if (progress >= 1) playing = false;
    update();
  }
  previous = now;
  requestAnimationFrame(frame);
}

update();
requestAnimationFrame(frame);
