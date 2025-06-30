#!/usr/bin/env node

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
  })
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': mimetype || 'application/octet-stream' },
    body: fileData,
  })
  if (!resp.ok) {
    const msg = await resp.text()
    throw new Error(`Wasabi PUT failed: ${resp.status} - ${msg}`)
  }
  return `${WASABI_ENDPOINT.replace(/^https?:\/\//, `https://${WASABI_BUCKET}.s3.`)}${WASABI_REGION}.wasabisys.com/${wasabiKey}`
}

// == MUX: Direct Upload Function ==
async function uploadToMux({ fileData, mimetype, originalFilename }) {
  // Step 1: Get Mux Upload URL
  const assetRes = await fetch(MUX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      input: [{ url: null }],
      playback_policy: ['public'],
      new_asset_settings: { playback_policies: ['public'] },
      cors_origin: '*'
      // For instant upload use: { "input": [{ "url": null }] }
    }),
    // Basic auth: Mux uses API token/secret as username/password
    agent: undefined,
    duplex: "half",
    credentials: "include",
    // Node-fetch v3: use headers + `Authorization`
    // Browser: use btoa()
    // For node-fetch, send as basic auth:
    // See: https://github.com/node-fetch/node-fetch#http-basic-authentication
    // Best practice:
    //     headers: { Authorization: "Basic " + Buffer.from(id+":"+secret).toString("base64") }
    // But node-fetch doesn’t support username/password in URL field, only via Authorization header:
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString('base64'),
    }
  })

  if (!assetRes.ok) {
    const text = await assetRes.text()
    throw new Error(`MUX asset create failed: ${assetRes.status}: ${text}`)
  }
  const assetJson = await assetRes.json()
  const uploadObj = assetJson.data && assetJson.data && assetJson.data.upload_id ? assetJson.data : (assetJson.data && assetJson.data.inputs && assetJson.data.inputs[0]) || assetJson.data
  // fallback: find the upload URL
  const uploadUrl = (assetJson && assetJson.data && assetJson.data.upload_url) || (uploadObj && uploadObj.url)
  const assetId = assetJson.data && assetJson.data.id

  if (!uploadUrl) throw new Error('MUX did not return an upload_url')
  // Step 2: PUT the file to the upload_url
  const muxUploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    body: fileData,
    headers: {
      'Content-Type': mimetype || 'application/octet-stream',
      'Origin': '*',
      'x-requested-with': 'XMLHttpRequest'
    }
  })
  if (!muxUploadResp.ok) {
    const text = await muxUploadResp.text()
    throw new Error(`MUX PUT failed: ${muxUploadResp.status}: ${text}`)
  }
  // Step 3: return the asset id and url to client!
  return { mux_asset_id: assetId, upload_url: uploadUrl }
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
