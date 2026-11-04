var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/simulator.js
var ROBOT = Object.freeze({ id: "robot", source: "A pretend robot starts at square 0. At square 0 the card is green. At square 1 the first card is red and the next card is green. At square 2 the card is green. Green permits one forward move. Red forbids forward movement. Waiting one turn changes the red card to green. Collecting a star does not change the card. Stars are on squares 1 and 3. A star can only be collected while standing on its square. Goal: collect both stars and finish on square 3.", allowed: ["forward", "wait", "collect"], goal: "collect two stars and finish at square 3" });
function simulate(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 16) return { ok: false, error: "Plan must contain 1-16 actions.", trace: [] };
  let pos = 0, waited = false, collected = [];
  const trace = [];
  const fail = /* @__PURE__ */ __name((i, a, reason) => ({ ok: false, error: reason, violation_step: i + 1, action: a, trace, state: { pos, waited, collected: [...collected] } }), "fail");
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (!ROBOT.allowed.includes(action)) return fail(i, action, "Action is outside the fixed tool schema.");
    const color = pos === 1 && !waited ? "red" : "green";
    const before = { pos, card: color, collected: [...collected] };
    if (action === "forward") {
      if (color === "red") return fail(i, action, "Counterexample: square 1 has a red card. Forward is forbidden until a wait.");
      if (pos >= 3) return fail(i, action, "Counterexample: cannot leave the game board beyond square 3.");
      pos++;
    } else if (action === "wait") {
      if (color !== "red") return fail(i, action, "Counterexample: source permits waiting only when the card is red.");
      waited = true;
    } else {
      if (![1, 3].includes(pos)) return fail(i, action, "Counterexample: no star exists at this square.");
      if (collected.includes(pos)) return fail(i, action, "Counterexample: this star was already collected.");
      collected.push(pos);
    }
    trace.push({ step: i + 1, action, before, after: { pos, collected: [...collected] } });
  }
  const ok = pos === 3 && collected.length === 2;
  return { ok, trace, state: { pos, waited, collected }, ...ok ? {} : { error: "Plan ended without reaching both declared goals." } };
}
__name(simulate, "simulate");

// src/worker.js
var MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
var scenarios = [{ id: "robot", label: "Robot star plan", source: ROBOT.source }, { id: "unsupported", label: "Missing rules test", source: null }];
var headers = { "content-type": "application/json", "cache-control": "no-store" };
var json = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), { status, headers }), "json");
async function propose(env, counterexample) {
  const messages = [{ role: "system", content: 'You propose a bounded action plan for a fictional game. Use only the source rules and the allowed action enum. Do not add rules, tools, or natural-language actions. Return strict JSON: {"actions":["forward","collect",...],"note":"short explanation"}. Never claim you ran the simulator. Another deterministic program checks every step.' }, { role: "user", content: JSON.stringify({ source: ROBOT.source, goal: ROBOT.goal, allowed: ROBOT.allowed, max_steps: 16, ...counterexample ? { previous_failure: counterexample, checker_feedback: "Your previous plan was rejected by the simulator at step " + counterexample.check.violation_step + " (action \"" + counterexample.check.action + "\"): " + counterexample.check.error + " At that moment you were on square " + counterexample.check.state.pos + " with stars collected " + JSON.stringify(counterexample.check.state.collected) + ". Study the step-by-step trace in previous_failure.check.trace, which lists your exact square after each action, then propose a corrected plan that obeys the source rules at every step." } : {} }) }];
  const result = await env.AI.run(MODEL, { messages, max_tokens: 500, temperature: 0.1 });
  let raw = typeof result?.response === "string" ? result.response : result?.choices?.[0]?.message?.content ?? "";
  if (typeof raw !== "string" || !raw) return { error: "Unexpected AI result shape", shape: JSON.stringify(result)?.slice(0, 300) ?? typeof result };
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return { error: "Malformed model JSON", model_called: true, raw_preview: raw.slice(0, 300) };
  }
  if (!Array.isArray(parsed.actions)) return { error: "Model did not return an action array", model_called: true };
  return { actions: parsed.actions, note: typeof parsed.note === "string" ? parsed.note.slice(0, 400) : "", model_called: true };
}
__name(propose, "propose");
var worker_default = { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/scenarios" && request.method === "GET") return json(scenarios);
  if (url.pathname === "/api/plan" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (Object.keys(body).length !== 1 || typeof body.scenario_id !== "string") return json({ error: "Only a preset synthetic scenario ID is accepted." }, 400);
    const fixture = scenarios.find((x) => x.id === body.scenario_id);
    if (!fixture) return json({ error: "Unknown scenario" }, 400);
    if (!fixture.source) return json({ status: "refused", model_called: false, message: "No rules define this scenario. No model call or plan execution." });
    try {
      const first = await propose(env);
      if (first.error) return json({ status: "invalid_output", model: MODEL, ...first });
      const firstCheck = simulate(first.actions);
      const attempts = [{ ...first, check: firstCheck }];
      if (!firstCheck.ok) {
        const second = await propose(env, { actions: first.actions, check: firstCheck });
        if (second.error) attempts.push(second);
        else attempts.push({ ...second, check: simulate(second.actions) });
      }
      const last = attempts.at(-1);
      return json({ status: last.check?.ok ? "verified_against_fixture" : "not_verified", model_called: true, model: MODEL, source: ROBOT.source, attempts, scope: "Verified means only that the trace conforms to this fixed fictional simulator. Not real-world truth, teaching approval, or child release." });
    } catch (e) {
      return json({ status: "unavailable", message: "Live inference failed. No simulated model answer substituted.", detail: String(e).slice(0, 250) }, 503);
    }
  }
  if (url.pathname === "/api/counterexample" && request.method === "GET") {
    const actions = ["forward", "collect", "forward", "forward", "collect"];
    return json({ label: "Developer-authored negative test. Not a model response.", actions, check: simulate(actions) });
  }
  if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
  return env.ASSETS.fetch(request);
} };
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
