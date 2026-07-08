/**
 * Worker Cloudflare — Coffre de la Famille Silva
 * Lit le salon Discord du coffre (via un bot), calcule le stock,
 * et renvoie le résultat au dashboard.
 *
 * Ce fichier ne contient AUCUN secret : le token du bot est stocké
 * dans Cloudflare (variable secrète DISCORD_TOKEN), jamais ici.
 */

const CHANNEL_ID = "1521913399485665334"; // salon du coffre (Captain Silva)
const MAX_PAGES = 10;   // lit jusqu'à 1000 derniers messages
const CACHE_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json; charset=utf-8",
    };

    try {
      // Petit cache : on n'interroge Discord qu'une fois par minute maximum.
      const cache = caches.default;
      const cacheKey = new Request("https://coffre-silva.cache/v1");
      const cached = await cache.match(cacheKey);
      if (cached) {
        const body = await cached.text();
        return new Response(body, { headers: cors });
      }

      // Lecture des messages du salon, du plus récent au plus ancien.
      let all = [];
      let before = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const url = new URL(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`);
        url.searchParams.set("limit", "100");
        if (before) url.searchParams.set("before", before);
        const r = await fetch(url.toString(), {
          headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
        });
        if (!r.ok) throw new Error("Discord a répondu " + r.status);
        const batch = await r.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        all = all.concat(batch);
        if (batch.length < 100) break;
        before = batch[batch.length - 1].id;
      }

      // Analyse : "Javier Silva a déposé 74x Pochon De Mexicana"
      const moves = [];
      for (const m of all) {
        const texts = [];
        if (m.content) texts.push(m.content);
        for (const e of m.embeds || []) {
          if (e.title) texts.push(e.title);
          if (e.description) texts.push(e.description);
          for (const f of e.fields || []) texts.push((f.name || "") + " " + (f.value || ""));
        }
        const joined = texts.join(" ").replace(/\*/g, "").replace(/\s+/g, " ").trim();
        const match = joined.match(/(.+?)\s+a\s+(d[ée]pos[ée]|retir[ée])\s+(\d+)\s*x\s+(.+)/i);
        if (match) {
          moves.push({
            qui: match[1].trim(),
            action: /d[ée]pos/i.test(match[2]) ? "dépôt" : "retrait",
            qty: parseInt(match[3], 10),
            item: match[4].trim(),
            date: m.timestamp,
          });
        }
      }

      // Stock = somme des dépôts - somme des retraits, par objet.
      const stock = {};
      for (const mv of moves) {
        stock[mv.item] = (stock[mv.item] || 0) + (mv.action === "dépôt" ? mv.qty : -mv.qty);
      }

      const body = JSON.stringify({
        maj: new Date().toISOString(),
        messages_lus: all.length,
        mouvements: moves.slice(0, 40),
        stock,
      });

      const toCache = new Response(body, {
        headers: { ...cors, "Cache-Control": `max-age=${CACHE_SECONDS}` },
      });
      ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
      return new Response(body, { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors });
    }
  },
};
