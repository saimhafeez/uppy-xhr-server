#!/usr/bin/env node

import { randomUUID } from 'crypto';
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import fs from 'node:fs/promises'
import formidable from 'formidable'
import fetch from 'node-fetch'
import AWS from 'aws-sdk'

// Wasabi Config
const WASABI_BUCKET = 'upward'
const WASABI_REGION = 'us-east-2'
const WASABI_ENDPOINT = 'https://s3.us-east-2.wasabisys.com'
const WASABI_KEY = 'HZOUCM9I2D1MI9HGYL5A'
const WASABI_SECRET = 'wbD9rW8BG08UgX6z19kRa7nc7hzl16vRhEv3TIE6'

// Mux Config
const MUX_TOKEN_ID = "6b6f9f5c-61d8-4a79-8428-1b38a3a08c0e"
const MUX_TOKEN_SECRET = "B7VRg2PQjIQ8kE57KDr64HX9B5/8DMO9rJWRgeYuR7TMIpZQSpWRTJVS/P/iynYgFeUat2T/KtS"
const MUX_API_URL = 'https://api.mux.com/video/v1/assets'

const UPLOAD_DIR = new URL('./uploads/', import.meta.url)
await mkdir(UPLOAD_DIR, { recursive: true })

const s3 = new AWS.S3({
  endpoint: WASABI_ENDPOINT,
  region: WASABI_REGION,
  accessKeyId: WASABI_KEY,
  secretAccessKey: WASABI_SECRET,
  signatureVersion: 'v4',
})

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'OPTIONS, POST, GET',
  'Access-Control-Max-Age': 2592000,
}

const isVideoOrAudio = (mimetype) =>
  mimetype && (
    mimetype.startsWith('video/') ||
    mimetype.startsWith('audio/') ||
    mimetype === 'application/mp4' // Some uploads report as generic
  )

async function uploadToWasabi({ fileData, wasabiKey, mimetype }) {
  const url = await s3.getSignedUrlPromise('putObject', {
    Bucket: WASABI_BUCKET,
    Key: wasabiKey,
    ContentType: mimetype || 'application/octet-stream',
    Expires: 600,
    ACL: 'public-read',   // <-- add this!
  })
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': mimetype || 'application/octet-stream',
      'x-amz-acl': 'public-read'       // <-- critical for compliance!
    },
    body: fileData,
  })
  if (!resp.ok) {
    const msg = await resp.text()
    throw new Error(`Wasabi PUT failed: ${resp.status} - ${msg}`)
  }
  return `https://${WASABI_BUCKET}.s3.${WASABI_REGION}.wasabisys.com/${wasabiKey}`;
}

// == MUX: Direct Upload Function ==
async function uploadToMux({ fileData, mimetype, originalFilename }) {
  // 🆕 Generate a random external_id for this asset
  const external_id = randomUUID(); // If on old Node.js: use Date.now() + Math.random().toString(36).slice(2)

  // 1. Create direct upload URL (attach meta.external_id)
  const response = await fetch('https://api.mux.com/video/v1/uploads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString('base64'),
    },
    body: JSON.stringify({
      new_asset_settings: {
        playback_policies: ['public'],
        passthrough: originalFilename,
        meta: {
          external_id // include the random id here
        }
      }
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MUX upload create failed: ${response.status}: ${text}`)
  }
  const json = await response.json();
  const upload_url = json.data.url;
  const upload_id = json.data.id;

  // 2. PUT the video file to mux upload_url
  const uploadResp = await fetch(upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': mimetype || 'application/octet-stream',
      'Origin': '*'
    },
    body: fileData
  });
  if (!uploadResp.ok) {
    const text = await uploadResp.text();
    throw new Error(`MUX upload PUT failed: ${uploadResp.status}: ${text}`)
  }

  // 3. Return the relevant details
  return {
    mux_upload_id: upload_id,
    upload_url,
    external_id // return the random external_id as well
  };
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers)
    res.end()
    return
  }

  if (req.url === '/upload' && req.method.toLowerCase() === 'post') {
    const form = formidable({ multiples: false, uploadDir: fileURLToPath(UPLOAD_DIR), keepExtensions: true })

    form.parse(req, async (err, fields, files) => {
      if (err) {
        res.writeHead(500, headers)
        res.end(JSON.stringify({ error: err.message }))
        return
      }
      try {
        const uploaded = (files.file && files.file[0]) || files[Object.keys(files)[0]][0]
        const { filepath, originalFilename, mimetype, size } = uploaded
        const timestamp = Date.now()
        const safeName = originalFilename.replace(/[^\w.\-]/g, '_')

        const fileData = await fs.readFile(filepath)

        let result = {}
        if (isVideoOrAudio(mimetype)) {
          // 🔴 Upload to Mux!
          result = await uploadToMux({ fileData, mimetype, originalFilename })
        } else {
          // 🟢 Upload to Wasabi!
          const wasabiKey = `${timestamp}_${safeName}`
          const url = await uploadToWasabi({ fileData, wasabiKey, mimetype })
          result = { wasabi_url: url }
        }

        // Clean up temp file
        await fs.unlink(filepath).catch(() => { })

        res.writeHead(200, headers)
        res.end(JSON.stringify({
          ok: true,
          filename: originalFilename,
          mimetype,
          size,
          ...result
        }))
      } catch (e) {
        res.writeHead(500, headers)
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }

  res.writeHead(404, headers)
  res.end(JSON.stringify({ error: 'Not found' }))
}).listen(3020, () => {
  console.log('server started on http://localhost:3020')
})
