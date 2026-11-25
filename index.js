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
let logVote = async () => {} // only does something when Redis is connected
let claimVote, releaseVote
let countBlocked = async () => {}

// Max votes accepted from one network address (many people can share one).
// Set the MAX_VOTES_PER_IP environment variable to change it. 0 turns the cap off.
const envMax = parseInt(process.env.MAX_VOTES_PER_IP, 10)
const MAX_PER_IP = Number.isNaN(envMax) ? 5 : envMax

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

  // One vote per browser (cookie ID), plus a cap on votes per network address.
  // The ID goes into the "voters" set; sadd is atomic, so two simultaneous
  // requests from one browser can't both succeed. "ipcounts" holds accepted
  // votes per scrambled network address.
  claimVote = async (voterId, ipHash) => {
    const added = await redis.sadd("voters", voterId)
    if (!added) return "already_voted"
    const count = await redis.hincrby("ipcounts", ipHash, 1)
    if (MAX_PER_IP > 0 && count > MAX_PER_IP) {
      await redis.hincrby("ipcounts", ipHash, -1)
      await redis.srem("voters", voterId)
      return "network_limit"
    }
    return "ok"
  }

  // Undo a claim if saving the vote failed afterwards
  releaseVote = async (voterId, ipHash) => {
    await redis.srem("voters", voterId)
    await redis.hincrby("ipcounts", ipHash, -1)
  }

  // Counts how many repeat votes were turned away ("blockedvotes" key)
  countBlocked = async () => {
    try {
      await redis.incr("blockedvotes")
    } catch {}
  }

  // Vote log: one entry per vote (newest first) in the "votelog" list.
  // IPs are hashed, so the raw address is never stored.
  logVote = async ({ label, ip, ua }) => {
    const ipHash = hashIp(ip)
    const device = /mobile|android|iphone|ipad/i.test(ua) ? "mobile" : "desktop"
    const entry = JSON.stringify({
      time: new Date().toISOString(), // UTC. Lagos is UTC+1
      contestant: label,
      ipHash,
      device,
      browser: ua.slice(0, 100),
    })
    await redis.lpush("votelog", entry)
    await redis.ltrim("votelog", 0, 4999) // keep the latest 5000 votes
  }

  resetVotes = async () => {
    await redis.del(KEY, "votelog", "ipcounts", "voters", "blockedvotes")
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

  // Local testing only: remembered in memory, so restarting the server clears it
  const localVoters = new Set()
  const localIps = new Map()

  claimVote = async (voterId, ipHash) => {
    if (localVoters.has(voterId)) return "already_voted"
    const count = (localIps.get(ipHash) || 0) + 1
    if (MAX_PER_IP > 0 && count > MAX_PER_IP) return "network_limit"
    localVoters.add(voterId)
    localIps.set(ipHash, count)
    return "ok"
  }

  releaseVote = async (voterId, ipHash) => {
    localVoters.delete(voterId)
    localIps.set(ipHash, Math.max(0, (localIps.get(ipHash) || 1) - 1))
  }

  resetVotes = () => {
    localVoters.clear()
    localIps.clear()
    const job = queue.then(() => fs.writeFile(dataFile, JSON.stringify(INITIAL, null, 2)))
    queue = job.catch(() => {})
    return job
  }

  console.log("Storage: local data.json")
}

// ---------- Helpers ----------
function hashIp(ip) {
  return crypto
    .createHash("sha256")
    .update(ip + (process.env.LOG_SALT || "delife"))
    .digest("hex")
    .slice(0, 12)
}

function readCookie(req, name) {
  const header = req.headers.cookie || ""
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return decodeURIComponent(rest.join("="))
  }
  return null
}

function clientIp(req) {
  // On Vercel the visitor's address arrives in the x-forwarded-for header
  const forwarded = req.headers["x-forwarded-for"]
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim()
  }
  return req.socket.remoteAddress || "unknown"
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

  // Each browser gets a random voter ID in a cookie (kept for a year)
  let voterId = readCookie(req, "voter")
  if (!voterId || !/^[0-9a-f-]{36}$/.test(voterId)) voterId = crypto.randomUUID()
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""
  res.setHeader(
    "Set-Cookie",
    `voter=${voterId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`
  )

  const ip = clientIp(req)
  const ipHash = hashIp(ip)

  try {
    const claim = await claimVote(voterId, ipHash)
    if (claim !== "ok") {
      await countBlocked()
      return res.status(claim === "already_voted" ? 409 : 429).json({ error: claim })
    }

    try {
      await addVote(label)
    } catch (err) {
      await releaseVote(voterId, ipHash) // give the claim back so they can retry
      throw err
    }

    try {
      await logVote({ label, ip, ua: req.headers["user-agent"] || "" })
    } catch (err) {
      console.error("Vote log failed (the vote was still counted):", err)
    }
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
