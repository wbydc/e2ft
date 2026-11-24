import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SpeedGraph } from "../speed-graph.ts";

/** The y of each point after the opening `M0,40`, from the drawn path. */
const heights = (graph: SpeedGraph) =>
  graph
    .path()
    .split("L")
    .slice(1, -1)
    .map((point) => Number(point.split(",")[1]));

describe("SpeedGraph", () => {
  describe("path", () => {
    test("an empty graph draws nothing", () => {
      const graph = new SpeedGraph();

      const path = graph.path();

      assert.equal(path, "");
    });

    test("a steady speed fills the done part at the top", () => {
      const graph = new SpeedGraph();

      for (let percent = 1; percent <= 50; percent++) graph.add(percent / 100, 1_000_000);
      const path = graph.path();

      assert.match(path, /^M0,40L0,1L0.5,1L1.5,1/);
      assert.match(path, /L49.5,1L50,1L50,40Z$/);
    });

    test("a slower stretch shows as a dip", () => {
      const graph = new SpeedGraph();

      for (let percent = 1; percent <= 30; percent++)
        graph.add(percent / 100, percent > 10 && percent <= 20 ? 0 : 1000);
      const points = heights(graph);

      assert.equal(points[5], 1);
      assert.ok(points[18] > 35);
      assert.ok(points[29] < 5);
    });

    test("a new peak rescales the earlier part down", () => {
      const graph = new SpeedGraph();

      for (let percent = 1; percent <= 10; percent++) graph.add(percent / 100, 1000);
      for (let percent = 11; percent <= 20; percent++) graph.add(percent / 100, 4000);
      const points = heights(graph);

      assert.equal(Math.min(...points), 1);
      assert.ok(Math.abs(points[5] - 30.25) < 0.1);
    });

    test("a render that skipped buckets fills them all with its speed", () => {
      const graph = new SpeedGraph();

      graph.add(0.01, 1000);
      graph.add(0.4, 1000);
      const path = graph.path();

      assert.match(path, /L39.5,1L40,1L40,40Z$/);
    });
  });

  describe("height", () => {
    test("is the current speed against the peak", () => {
      const graph = new SpeedGraph();

      graph.add(0.1, 1000);
      graph.add(0.2, 0);
      graph.add(0.3, 0);
      const height = graph.height();

      assert.equal(height, 0.25);
    });
  });
});
