import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { spawn } from "child_process";
import archiver from "archiver";

const app = express();
app.use(cors());

app.get("/", (req,res)=> res.send("OK"));

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
if (!YOUTUBE_API_KEY) console.warn("Missing YOUTUBE_API_KEY env var.");

function isUrl(str){ try { new URL(str); return true; } catch { return false; } }

function extractHandleOrId(ref){
  const s = (ref || "").trim();
  if (!s) return { type:"unknown", value:"" };
  if (/^UC[a-zA-Z0-9_-]{20,}$/.test(s)) return { type:"channelId", value:s };
  if (s.startsWith("@")) return { type:"handle", value:s.replace(/^@/,"") };

  if (isUrl(s)){
    const u = new URL(s);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "channel" && parts[1]) return { type:"channelId", value:parts[1] };
    if (parts[0] && parts[0].startsWith("@")) return { type:"handle", value:parts[0].slice(1) };
    if (parts[0] === "c" && parts[1]) return { type:"search", value:parts[1] };
    if (parts[0] === "user" && parts[1]) return { type:"search", value:parts[1] };
    if (parts[0]) return { type:"search", value:parts[0] };
  }
  return { type:"search", value:s };
}

async function ytApi(path, params){
  const url = new URL("https://www.googleapis.com/youtube/v3/" + path);
  Object.entries(params).forEach(([k,v])=> url.searchParams.set(k, v));
  url.searchParams.set("key", YOUTUBE_API_KEY || "");
  const r = await fetch(url);
  if (!r.ok) throw new Error("YouTube API error " + r.status);
  return r.json();
}

async function resolveChannelId(ref){
  const parsed = extractHandleOrId(ref);
  if (parsed.type === "channelId") return parsed.value;

  if (parsed.type === "handle") {
    const js = await ytApi("channels", { part:"id,snippet", forHandle: parsed.value, maxResults:"1" });
    const item = js.items?.[0];
    if (item?.id) return item.id;
  }

  const q = parsed.value;
  const sjs = await ytApi("search", { part:"snippet", q, type:"channel", maxResults:"1" });
  const cid = sjs.items?.[0]?.snippet?.channelId;
  if (cid) return cid;

  throw new Error("Cannot resolve channel");
}

function iso8601ToSeconds(d){
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || "");
  if(!m) return 0;
  const h = parseInt(m[1]||"0",10);
  const mi = parseInt(m[2]||"0",10);
  const s = parseInt(m[3]||"0",10);
  return h*3600 + mi*60 + s;
}
function secondsToText(total){
  total = Math.max(0, Math.floor(total||0));
  const h = Math.floor(total/3600);
  const m = Math.floor((total%3600)/60);
  const s = total%60;
  const pad = (n)=> String(n).padStart(2,"0");
  if(h>0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}
function bestThumb(thumbnails){
  if(!thumbnails) return "";
  return thumbnails.maxres?.url || thumbnails.standard?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || "";
}

async function listUploadsVideoIds(channelId){
  const ch = await ytApi("channels", { part:"contentDetails,snippet", id: channelId, maxResults:"1" });
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  const channelTitle = ch.items?.[0]?.snippet?.title || "";
  if(!uploads) throw new Error("No uploads playlist");
  const ids = [];
  let pageToken = "";
  while(true){
    const pli = await ytApi("playlistItems", { part:"contentDetails", playlistId: uploads, maxResults:"50", pageToken });
    (pli.items||[]).forEach(it=>{
      const vid = it.contentDetails?.videoId;
      if(vid) ids.push(vid);
    });
    pageToken = pli.nextPageToken || "";
    if(!pageToken) break;
    if(ids.length >= 1500) break;
  }
  return { ids, channelTitle };
}

async function fetchVideosDetails(videoIds){
  const out = [];
  for(let i=0;i<videoIds.length;i+=50){
    const chunk = videoIds.slice(i,i+50);
    const js = await ytApi("videos", { part:"snippet,contentDetails", id: chunk.join(","), maxResults:"50" });
    (js.items||[]).forEach(v=>{
      const durISO = v.contentDetails?.duration || "PT0S";
      const secs = iso8601ToSeconds(durISO);
      out.push({
        title: v.snippet?.title || "",
        videoId: v.id,
        durationSeconds: secs,
        durationText: secondsToText(secs),
        thumbnail: bestThumb(v.snippet?.thumbnails)
      });
    });
  }
  return out;
}

async function listPlaylists(channelId){
  const items = [];
  let pageToken = "";
  while(true){
    const js = await ytApi("playlists", { part:"snippet,contentDetails", channelId, maxResults:"50", pageToken });
    (js.items||[]).forEach(p=>{
      items.push({
        playlistId: p.id,
        title: p.snippet?.title || "",
        thumbnail: bestThumb(p.snippet?.thumbnails),
        itemCount: p.contentDetails?.itemCount ?? null
      });
    });
    pageToken = js.nextPageToken || "";
    if(!pageToken) break;
    if(items.length >= 500) break;
  }
  return items;
}

app.get("/channel", async (req,res)=>{
  try{
    const ref = String(req.query.ref||"").trim();
    if(!ref) return res.status(400).send("Missing ref");
    if(!YOUTUBE_API_KEY) return res.status(500).send("Server missing YOUTUBE_API_KEY");

    const channelId = await resolveChannelId(ref);
    const { ids, channelTitle } = await listUploadsVideoIds(channelId);
    const videos = await fetchVideosDetails(ids);

    const shorts = videos.filter(v=> v.durationSeconds > 0 && v.durationSeconds < 60);
    const long = videos.filter(v=> v.durationSeconds >= 60);

    const playlists = await listPlaylists(channelId);

    res.json({ channelId, channelTitle, long, shorts, playlists });
  }catch(err){
    res.status(500).send(err?.message || "Error");
  }
});

app.get("/download/thumbnail", async (req,res)=>{
  try{
    const videoId = String(req.query.videoId||"").trim();
    if(!videoId) return res.status(400).send("Missing videoId");
    if(!YOUTUBE_API_KEY) return res.status(500).send("Server missing YOUTUBE_API_KEY");

    const js = await ytApi("videos", { part:"snippet", id: videoId, maxResults:"1" });
    const v = js.items?.[0];
    if(!v) return res.status(404).send("Not found");
    const url = bestThumb(v.snippet?.thumbnails);
    if(!url) return res.status(404).send("No thumbnail");

    const img = await fetch(url);
    if(!img.ok) return res.status(500).send("Failed to fetch thumbnail");
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${videoId}.jpg"`);
    img.body.pipe(res);
  }catch(err){
    res.status(500).send(err?.message || "Error");
  }
});

function streamYtDlp(args, res, filename, contentType){
  const p = spawn("yt-dlp", args, { stdio:["ignore","pipe","pipe"] });
  let stderr = "";
  p.stderr.on("data", d=> { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
  p.on("close", code=>{
    if(code !== 0 && !res.headersSent){
      res.status(500).send(stderr || ("yt-dlp failed " + code));
    }
  });
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  p.stdout.pipe(res);
}

app.get("/download/video", async (req,res)=>{
  const videoId = String(req.query.videoId||"").trim();
  if(!videoId) return res.status(400).send("Missing videoId");
  const url = "https://www.youtube.com/watch?v=" + videoId;
  const args = ["-f","bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b","-o","-", url];
  streamYtDlp(args, res, `${videoId}.mp4`, "video/mp4");
});

app.get("/download/audio", async (req,res)=>{
  const videoId = String(req.query.videoId||"").trim();
  if(!videoId) return res.status(400).send("Missing videoId");
  const url = "https://www.youtube.com/watch?v=" + videoId;
  const args = ["-x","--audio-format","mp3","--audio-quality","0","-o","-", url];
  streamYtDlp(args, res, `${videoId}.mp3`, "audio/mpeg");
});

app.get("/download/pagezip", async (req,res)=>{
  try{
    const ref = String(req.query.channel||"").trim();
    if(!ref) return res.status(400).send("Missing channel");
    if(!YOUTUBE_API_KEY) return res.status(500).send("Server missing YOUTUBE_API_KEY");

    const channelId = await resolveChannelId(ref);
    const { ids } = await listUploadsVideoIds(channelId);
    const videos = await fetchVideosDetails(ids);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="channel_downloads.zip"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", err => { throw err; });
    archive.pipe(res);

    const limited = videos.slice(0, 80);

    for (const v of limited){
      const safe = (v.title || v.videoId).replace(/[\\/:*?"<>|]+/g," ").replace(/\s+/g," ").trim().slice(0,120);

      if(v.thumbnail){
        const img = await fetch(v.thumbnail);
        if(img.ok){
          const buf = Buffer.from(await img.arrayBuffer());
          archive.append(buf, { name: `${safe}.jpg` });
        }
      }

      const mp3Buf = await new Promise((resolve, reject)=>{
        const url = "https://www.youtube.com/watch?v=" + v.videoId;
        const p = spawn("yt-dlp", ["-x","--audio-format","mp3","--audio-quality","0","-o","-", url], { stdio:["ignore","pipe","pipe"] });
        const chunks = [];
        let stderr="";
        p.stdout.on("data", d=> chunks.push(d));
        p.stderr.on("data", d=> { stderr += d.toString(); if(stderr.length>4000) stderr=stderr.slice(-4000); });
        p.on("close", code=>{
          if(code===0) resolve(Buffer.concat(chunks));
          else reject(new Error(stderr || ("yt-dlp failed " + code)));
        });
      }).catch(()=> null);

      if(mp3Buf){
        archive.append(mp3Buf, { name: `${safe}.mp3` });
      }
    }

    await archive.finalize();
  }catch(err){
    res.status(500).send(err?.message || "Error");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Listening on " + PORT));



