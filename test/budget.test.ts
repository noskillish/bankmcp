import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleFor } from "../src/budget.ts";
import { defaultBudgetState } from "../src/budget-types.ts";

test("budget cycle follows a payroll day between 28 and 31", () => {
  assert.deepEqual(cycleFor(new Date("2026-11-02T12:00:00Z"), 28), {
    offset: 0,
    start: "2026-10-28",
    end: "2026-11-27",
    label: "28 oct – 27 nov",
  });
  assert.deepEqual(cycleFor(new Date("2026-11-30T12:00:00Z"), 31), {
    offset: 0,
    start: "2026-11-30",
    end: "2026-12-30",
    label: "30 nov – 30 dic",
  });
});

test("history offsets move backwards by complete payroll cycles", () => {
  const current = cycleFor(new Date("2026-11-02T12:00:00Z"), 28);
  const previous = cycleFor(new Date("2026-11-02T12:00:00Z"), 28, 1);
  assert.equal(previous.start, "2026-09-28");
  assert.equal(previous.end, "2026-10-27");
  assert.equal(current.offset, 0);
});

test("default budget is Spanish and uses a four-week leisure envelope", () => {
  const budget = defaultBudgetState();
  assert.equal(budget.payroll_day, 28);
  assert.equal(budget.budgets.leisure / 4, 80);
  assert.ok(budget.rules.some((rule) => rule.contains.includes("mercadona")));
});
