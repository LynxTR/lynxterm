import { expect, test } from "vite-plus/test";
import { bridge, buckets, parseSamples, rate } from "../app/composables/metrics";

test("parses sample lines and skips anything else", () => {
  const samples = parseSamples("on\n100 12 512 2048 40\n\ngarbage line\n160 99 600 2048 41\n");
  expect(samples).toEqual([
    { t: 100, cpu: 12, memUsed: 512, memTotal: 2048, disk: 40 },
    { t: 160, cpu: 99, memUsed: 600, memTotal: 2048, disk: 41 },
  ]);
});

test("parses load and network when the line has them", () => {
  expect(parseSamples("100 12 512 2048 40 0.84 4 1550000 387500")).toEqual([
    {
      t: 100,
      cpu: 12,
      memUsed: 512,
      memTotal: 2048,
      disk: 40,
      load: 0.84,
      cores: 4,
      rx: 1550000,
      tx: 387500,
    },
  ]);
  expect(parseSamples("100 12 512 2048 40 0.84 4")).toEqual([]);
});

test("rates read in bits", () => {
  expect(rate(1_550_000)).toBe("12.4 Mb/s");
  expect(rate(100_000)).toBe("800 kb/s");
  expect(rate(150_000_000)).toBe("1.2 Gb/s");
});

test("buckets keep the peak and leave gaps empty", () => {
  const samples = parseSamples("0 10 1 2 3\n5 80 1 2 3\n25 30 1 2 3\n99 5 1 2 3");
  expect(buckets(samples, (s) => s.cpu, 0, 40, 4)).toEqual([80, null, 30, null]);
});

test("buckets skip samples without the value", () => {
  const samples = parseSamples("0 10 1 2 3\n15 10 1 2 3 0.5 2 100 50");
  expect(buckets(samples, (s) => s.rx, 0, 20, 2)).toEqual([null, 100]);
});

test("bridge fills short gaps and keeps long ones", () => {
  expect(bridge([null, 5, null, null, 7, null, null, null, 9, null], 2)).toEqual([
    null,
    5,
    5,
    5,
    7,
    null,
    null,
    null,
    9,
    null,
  ]);
});
