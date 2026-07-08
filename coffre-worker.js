/**
 * Worker Cloudflare — Coffre de la Famille Silva (v2)
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
    const debug = new URL(request.url).searchParams.has("debug");

    try {
      // Petit cache : on n'interroge Discord qu'une fois par minute maximum.
      const cache = caches.default;
      const cacheKey = new Request("https://coffre-silva.cache/v2");
      if (!debug) {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const body = await cached.text();
          return new Response(body, { headers: cors });
        }
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

      // Mode debug : renvoie 2 messages bruts pour inspection.
      if (debug) {
        return new Response(JSON.stringify({ exemple: all.slice(0, 2) }, null, 2), { headers: cors });
      }

      // Analyse : "Javier Silva a déposé 74x Pochon De Mexicana"
      // Gère aussi les grands nombres avec séparateurs : "299 697x" ou "299,697x".
      const RE = /(.+?)\s+a\s+(d[ée]pos[ée]?|retir[ée]?)\s+(\d[\d\s.,]*)\s*x\s+(.+)/i;
      const moves = [];
      for (const m of all) {
        // On rassemble tous les endroits où le texte peut se cacher.
        const texts = [];
        if (m.content) texts.push(m.content);
        for (const e of m.embeds || []) {
          if (e.description) texts.push(e.description);
          for (const f of e.fields || []) {
            texts.push((f.name || "") + " " + (f.value || ""));
            texts.push(f.value || "");
          }
          if (e.title) texts.push(e.title);
          if (e.author && e.author.name) texts.push(e.author.name);
          if (e.footer && e.footer.text) texts.push(e.footer.text);
        }
        // On teste chaque fragment séparément : le premier qui matche gagne.
        for (const t of texts) {
          const clean = String(t).replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
          const match = clean.match(RE);
          if (match) {
            const item = match[4]
              .replace(/\s*(du|dans le|au)\s+coffre\s*!*\s*$/i, "") // "… du coffre !" → ""
              .replace(/[!.\s]+$/, "")
              .trim();
            moves.push({
              qui: match[1].trim(),
              action: /d[ée]pos/i.test(match[2]) ? "dépôt" : "retrait",
              qty: parseInt(match[3].replace(/[^\d]/g, ""), 10),
              item,
              date: m.timestamp,
            });
            break;
          }
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
        depuis: moves.length ? moves[moves.length - 1].date : null,
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
