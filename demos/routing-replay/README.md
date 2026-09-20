# Jev routing replay

A 12-second offline animation of the Jev routing contract. The example is illustrative: the host decides to delegate, `task_route` filters registered profiles, Jev selects one eligible profile, and the host owns worker execution and verification.

```sh
cd demos/routing-replay
bun install --frozen-lockfile
bun run build
bun run preview
```

Open `http://127.0.0.1:4430`. The animation plays automatically and provides play, pause, and replay controls. When the operating system requests reduced motion, the completed flow appears without positional motion.

`dist/` is a portable static build with no API or network dependency. `scripts/extract.ts` writes the curated fixture to `public/data/replay.json`, and the browser validates it with Zod before rendering.

The repository preview GIF (`../../docs/assets/routing-replay.gif`) was recorded from the running replay at a 1280×720 viewport through the in-app Browser capture workflow. The source animation is 12 seconds; the GIF is a compact 10-second, 40-frame loop sampled at 250 ms per frame. To reproduce it, run `bun run preview`, capture the viewport for one replay cycle, and encode the frames as an infinitely looping GIF with the same dimensions and interval.

The visual rhythm is inspired by [Tamara Tran's JevDemo on X](https://x.com/tamarajtran/status/2100694549362553153) and the MIT-licensed [fast-jev-compaction demo on GitHub](https://github.com/tamaratran/fast-jev-compaction/tree/main/demo/JevDemo). The flow and data in this replay are original.
