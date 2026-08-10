const ALLOWED_ORIGIN = 'https://royricht.github.io'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const SYSTEM_PROMPT = `You are helping refine a real-world distance measurement made with a phone's AR app.
The user photographed a surface and drew a bright green line on it marking two points they want the
real-world distance between. The app's own sensor-based (SLAM) estimate is provided for context, but
that estimate can be unreliable.

Look at the photo and the green line. Try to find an object near the line whose real-world size is
well-known or standardized (examples: electrical outlet/power socket, standard door, coin, credit
card, keyboard key pitch, sheet of paper, floor/wall tile, light switch, USB port, smartphone).
If you find one, use its known typical dimensions to estimate the real-world length of the green line,
and say exactly which object you used and why it's a reliable size reference.

If no such reference object is visible near the line, say so honestly rather than guessing — do not
fabricate a reference. In that case set referenceFound to false and either leave estimatedCm null or
give a low-confidence rough guess based on general visual scale cues, clearly marked low confidence.

Respond with ONLY a JSON object, no other text, matching exactly this shape:
{
  "referenceFound": boolean,
  "referenceDescription": string or null,
  "estimatedCm": number or null,
  "confidence": "low" | "medium" | "high",
  "explanation": string
}`

function extractJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

async function handleMeasure(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }

  const { image, slamEstimateCm } = body
  if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
    console.error('Bad image field. typeof:', typeof image, 'prefix:', typeof image === 'string' ? image.slice(0, 30) : image)
    return new Response(JSON.stringify({ error: 'Missing or invalid "image" (expected data: URI)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
  console.log('Received image, length:', image.length, 'prefix:', image.slice(0, 30))

  const userText = `The app's own SLAM-based estimate for this line is ${
    typeof slamEstimateCm === 'number' ? slamEstimateCm.toFixed(1) + ' cm' : 'unavailable'
  }. Analyze the photo and the green line as instructed.`

  const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'qwen/qwen3.6-27b',
      response_format: { type: 'json_object' },
      // Groq's free tier caps this model at 8000 tokens/minute, checked against
      // (prompt tokens + max_completion_tokens requested) BEFORE generation even starts —
      // not actual usage. reasoning_format:'hidden' still burns real (uncapped) hidden
      // reasoning tokens against that budget, which for a real photo reliably exhausted it
      // and produced an empty completion ("failed to validate json"). reasoning_effort:
      // 'none' disables reasoning entirely so token usage stays small and predictable.
      reasoning_effort: 'none',
      max_completion_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
    }),
  })

  console.log('Groq response status:', groqResponse.status)

  if (!groqResponse.ok) {
    const errText = await groqResponse.text()
    console.error('Groq error body:', errText)
    return new Response(JSON.stringify({ error: 'Upstream model call failed', detail: errText }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }

  const groqJson = await groqResponse.json()
  const content = groqJson.choices?.[0]?.message?.content || ''
  console.log('Groq content:', content)
  const parsed = extractJson(content)

  if (!parsed) {
    console.error('Failed to parse JSON from content:', content)
    return new Response(JSON.stringify({ error: 'Model did not return parseable JSON', raw: content }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders })
    }
    try {
      return await handleMeasure(request, env)
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Internal error', detail: String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }
  },
}
