// Lantern — headline usage stats for the pitch (data-backed strategy).
// Computes the after-hours share of youth messages (the core problem Lantern
// addresses), plus risk/language/MBTI coverage.
// Run: node eval/usage-stats.mjs
const U = "https://skkgaaijrslwclfednri.supabase.co";
const ANON = "sb_publishable_W0zoIpw-xHqFBIV7Ss-tkQ_UBf4w-4c";
// RLS is on, so reads need a privileged key. Pass it: SUPA_KEY=<service> node ...
const K = process.env.SUPA_KEY || ANON;
const H = { apikey: ANON, Authorization: `Bearer ${K}` };

async function get(path) {
  const r = await fetch(`${U}/rest/v1/${path}`, { headers: H });
  return r.json();
}

// Working hours = Mon-Fri 09:00-18:00 Singapore (UTC+8).
function isAfterHours(iso) {
  const sg = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const day = sg.getUTCDay(), hour = sg.getUTCHours();
  const working = day >= 1 && day <= 5 && hour >= 9 && hour < 18;
  return !working;
}

(async () => {
  const convs = await get("conversations?select=risk_level,crisis,preferred_language,mbti");
  const youthMsgs = await get("messages?role=eq.user&select=created_at");

  const total = Array.isArray(youthMsgs) ? youthMsgs.length : 0;
  const after = Array.isArray(youthMsgs) ? youthMsgs.filter(m => isAfterHours(m.created_at)).length : 0;
  const afterPct = total ? Math.round((after / total) * 100) : 0;

  const risk = {};
  const langs = new Set();
  let crisis = 0, withMbti = 0;
  (Array.isArray(convs) ? convs : []).forEach(c => {
    risk[c.risk_level || "unknown"] = (risk[c.risk_level || "unknown"] || 0) + 1;
    if (c.preferred_language) langs.add(c.preferred_language);
    if (c.crisis) crisis++;
    if (c.mbti) withMbti++;
  });

  console.log("================ LANTERN USAGE ================");
  console.log(`Youth conversations:        ${Array.isArray(convs) ? convs.length : 0}`);
  console.log(`Youth messages:             ${total}`);
  console.log(`After-hours youth messages: ${after} (${afterPct}%)  <- the coverage gap Lantern fills`);
  console.log(`Risk distribution:          ${JSON.stringify(risk)}`);
  console.log(`Crisis cases flagged:       ${crisis}`);
  console.log(`Languages seen:             ${langs.size ? [...langs].join(", ") : "English"}`);
  console.log(`Cases with inferred MBTI:   ${withMbti}`);
  console.log("==============================================");
})();
