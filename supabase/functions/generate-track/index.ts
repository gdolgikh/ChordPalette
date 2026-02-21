// Supabase Edge Function: generate-track
// Proxies requests to Replicate's MusicGen-Chord model.
//
// Required env var (set in Supabase dashboard → Edge Functions → Secrets):
//   REPLICATE_API_TOKEN — your Replicate API token
//
// Deploy: supabase functions deploy generate-track

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REPLICATE_API = "https://api.replicate.com/v1/predictions";
const MAX_POLL_TIME = 180_000; // 3 minutes
const POLL_INTERVAL = 2_000;   // 2 seconds

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 1. Auth — verify JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing authorization" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 2. Parse request
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { chords, bpm, timeSig, style, duration } = body;

  if (!chords || typeof chords !== "string") {
    return new Response(JSON.stringify({ error: "Missing chords" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const replicateToken = Deno.env.get("REPLICATE_API_TOKEN");
  if (!replicateToken) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 3. Create Replicate prediction
  const createRes = await fetch(REPLICATE_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${replicateToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // MusicGen-Chord model on Replicate
      model: "sakemin/musicgen-chord",
      input: {
        prompt: style || "acoustic backing track",
        text_chords: chords,
        bpm: Number(bpm) || 100,
        time_sig: timeSig || "4/4",
        duration: Math.min(Number(duration) || 15, 30),
        output_format: "mp3",
      },
    }),
  });

  if (!createRes.ok) {
    const errBody = await createRes.text();
    console.error("Replicate create error:", errBody);
    return new Response(JSON.stringify({ error: "Failed to start generation" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let prediction = await createRes.json();
  const pollUrl = prediction.urls?.get;

  if (!pollUrl) {
    return new Response(JSON.stringify({ error: "Invalid Replicate response" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 4. Poll until complete
  const startTime = Date.now();
  while (prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.status !== "canceled") {
    if (Date.now() - startTime > MAX_POLL_TIME) {
      return new Response(JSON.stringify({ error: "Generation timed out" }), {
        status: 504,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    const pollRes = await fetch(pollUrl, {
      headers: { "Authorization": `Bearer ${replicateToken}` },
    });
    prediction = await pollRes.json();
  }

  // 5. Return result
  if (prediction.status === "failed") {
    console.error("Replicate prediction failed:", prediction.error);
    return new Response(JSON.stringify({ error: prediction.error || "Generation failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (prediction.status === "canceled") {
    return new Response(JSON.stringify({ error: "Generation was canceled" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ audio_url: prediction.output }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
