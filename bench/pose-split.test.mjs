import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { splitPose, splitClockControl, snapshotShare, premiseVerdict } from "./pose-split.ts";
function normal(split) {
  let time = 0;
  let reads = 0;
  const events = [];
  const frames = [];
  const rigs = Array.from({ length: 100 }, (_, instance) => {
    let tick = 0;
    return { player: {
      advance(dt) {
        expect(dt).toBe(1 / 60);
        events.push(`advance:${instance}`);
        tick++;
        time += 2;
      },
      posedFrame() {
        events.push(`snapshot:${instance}`);
        time += 8;
        return { instance, tick };
      }
    } };
  });
  const timing = split(rigs, frames, 1 / 60, () => {
    reads++;
    return time;
  });
  expect(timing).toEqual({ advanceMs: 200, snapshotMs: 800 });
  expect(reads).toBe(300);
  expect(events).toEqual(rigs.flatMap((_, i) => [`advance:${i}`, `snapshot:${i}`]));
  expect(frames).toEqual(rigs.map((_, instance) => ({ instance, tick: 1 })));
}
describe("pose split instrumentation controls", () => {
  test("normal: 100 adjacent advance/snapshot pairs, same frame, exact sums", () => normal(splitPose));
  test("clock control: three reads per instance and no player operations", () => {
    let ticks = 0;
    expect(splitClockControl(100, () => ticks++)).toEqual({ advanceMs: 100, snapshotMs: 100 });
    expect(ticks).toBe(300);
  });
  test("edge: no instances yields zero work; zero pose refuses a verdict", () => {
    expect(splitPose([], [], 1 / 60, () => {
      throw new Error("unexpected clock");
    })).toEqual({ advanceMs: 0, snapshotMs: 0 });
    expect(() => snapshotShare(0, 0)).toThrow("BENCH_POSE_SPLIT");
    for (const pair of [[-1, 1], [2, 1], [NaN, 1], [0, 1 / 0]]) {
      expect(() => snapshotShare(pair[0], pair[1])).toThrow("BENCH_POSE_SPLIT");
    }
    expect(snapshotShare(0, 10)).toBe(0);
    expect(premiseVerdict(0.999, 10)).toBe("premise-refuted");
    expect(premiseVerdict(1, 10)).toBe("eligible");
  });
  test("defects: reversed calls, omitted snapshot and moved threshold are killed in memory", async () => {
    const source = readFileSync(new URL("./pose-split.ts", import.meta.url), "utf8");
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const replacements = [
      ["r.player.advance(dt);", "frames[i] = r.player.posedFrame();", "frames[i] = r.player.posedFrame();", "r.player.advance(dt);"],
      ["frames[i] = r.player.posedFrame();", "/* omitted snapshot */"],
      ["< 0.1", "< 0.01"]
    ];
    for (const [index, replacement] of replacements.entries()) {
      let mutated = source.replace(replacement[0], "__MUTANT_MARKER__");
      if (replacement.length === 4)
        mutated = mutated.replace(replacement[2], replacement[3]);
      mutated = mutated.replace("__MUTANT_MARKER__", replacement[1]);
      expect(mutated).not.toBe(source);
      const code = transpiler.transformSync(mutated);
      const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
      if (index < 2)
        expect(() => normal(module.splitPose)).toThrow();
      else
        expect(module.premiseVerdict(0.999, 10)).not.toBe("premise-refuted");
    }
  });
  test("structural edge: original bench workload and draw path remain present", () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(source).toContain(`r.player.advance(stepDt);
      posedFrames[i] = r.player.posedFrame();`);
    expect(source).toContain("rigs[i].renderer.render(posedFrames[i]);");
    expect(source).toContain("splitPose(rigs, posedFrames, stepDt, () => performance.now())");
  });
});
