const express = require("express")
const fs = require("fs").promises
const path = require("path")
const crypto = require("crypto")

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

// CORS: only needed if you open the pages with Live Server (port 5500)
const allowedOrigins = ["http://127.0.0.1:5500", "http://localhost:5500"]
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin)
    res.header("Vary", "Origin")
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.header("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.sendStatus(204)
  next()
})

// Serves the website when running locally. On Vercel, everything inside the
// /public folder is served by Vercel itself, so this only matters for `npm start`.
app.use(express.static(path.join(__dirname, "public")))

// ---------- Contestants (starting scores) ----------
// The names here must match the keys in `contestantMedia` at the top of public/vote.js
const INITIAL = {
  "Prisca (Lagos)": 0,
  "Victor (Lagos)": 0,
  "Mercy (Osun)": 0,
}

// ---------- Storage ----------
// On Vercel the file system is read-only, so votes live in Redis (Upstash).
// Locally (no Redis variables set) votes are saved in data.json instead.
const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN

let getVotes, addVote, resetVotes

if (redisUrl && redisToken) {
  const { Redis } = require("@upstash/redis")
  const redis = new Redis({ url: redisUrl, token: redisToken })
  const KEY = "votes"

  let seeded = null
  function ensureSeeded() {
    if (!seeded) {
      // hsetnx only sets a field if it doesn't exist yet, so it never resets real votes
      seeded = Promise.all(
        Object.entries(INITIAL).map(([name, n]) => redis.hsetnx(KEY, name, n))
      ).catch((err) => {
        seeded = null
        throw err
      })
    }
    return seeded
  }

  getVotes = async () => {
    await ensureSeeded()
    return (await redis.hgetall(KEY)) || {}
  }

  // hincrby is atomic, so simultaneous votes are never lost
  addVote = async (label) => {
    await ensureSeeded()
    await redis.hincrby(KEY, label, 1)
  }

  resetVotes = async () => {
    await redis.del(KEY)
    seeded = null
    await ensureSeeded() // recreates every contestant at the starting score
  }

  console.log("Storage: Upstash Redis")
} else {
  const dataFile = path.join(__dirname, "data.json")

  async function readFile() {
    try {
      return JSON.parse(await fs.readFile(dataFile, "utf-8"))
    } catch (err) {
      if (err.code !== "ENOENT") throw err
      await fs.writeFile(dataFile, JSON.stringify(INITIAL, null, 2))
      return { ...INITIAL }
    }
  }

  let queue = Promise.resolve()

  getVotes = readFile

  addVote = (label) => {
    const job = queue.then(async () => {
      const data = await readFile()
      data[label] = (Number(data[label]) || 0) + 1
      await fs.writeFile(dataFile, JSON.stringify(data, null, 2))
    })
    queue = job.catch(() => {})
    return job
  }

  resetVotes = () => {
    const job = queue.then(() => fs.writeFile(dataFile, JSON.stringify(INITIAL, null, 2)))
    queue = job.catch(() => {})
    return job
  }

  console.log("Storage: local data.json")
}

// ---------- Poll API ----------
app.get("/poll", async (req, res) => {
  try {
    const raw = await getVotes()
    // Always list every contestant, even if Redis is missing one
    const votes = Object.fromEntries(
      Object.keys(INITIAL).map((name) => [name, Number(raw[name]) || 0])
    )
    const total = Object.values(votes).reduce((sum, n) => sum + n, 0)

    res.json(
      Object.entries(votes).map(([label, n]) => ({
        label,
        percentage: (((100 * n) / total) || 0).toFixed(0),
      }))
    )
  } catch (err) {
    console.error("GET /poll failed:", err)
    res.status(500).json({ error: "Could not load poll" })
  }
})

app.post("/poll", async (req, res) => {
  const label = req.body && req.body.add

  if (typeof label !== "string" || !Object.hasOwn(INITIAL, label)) {
    return res.status(400).json({ error: "Unknown contestant" })
  }

  try {
    await addVote(label)
    res.json({ ok: true })
  } catch (err) {
    console.error("POST /poll failed:", err)
    res.status(500).json({ error: "Could not save vote" })
  }
})

// ---------- Secret reset link ----------
// Visit /reset?key=YOUR_SECRET to set every score back to the starting value.
// The secret comes from the RESET_KEY environment variable. If RESET_KEY is not
// set, the link is switched off completely. Wrong or missing keys get a plain 404.
function keyMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

app.get("/reset", async (req, res) => {
  if (!process.env.RESET_KEY || !keyMatches(req.query.key, process.env.RESET_KEY)) {
    return res.status(404).send("Not found")
  }
  try {
    await resetVotes()
    res.send("All scores have been reset to 0.")
  } catch (err) {
    console.error("Reset failed:", err)
    res.status(500).send("Reset failed. Check the server logs.")
  }
})

// Start a server only when run directly (npm start). On Vercel the exported app is used.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server is running on http://localhost:${PORT}`))
}

module.exports = app