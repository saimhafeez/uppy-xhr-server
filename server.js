#!/usr/bin/env node

import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import fs from 'node:fs/promises'
import formidable from 'formidable'
import fetch from 'node-fetch'                    // for streaming upload
import AWS from 'aws-sdk'                         // S3 compatible for Wasabi

const UPLOAD_DIR = new URL('./uploads/', import.meta.url)
await mkdir(UPLOAD_DIR, { recursive: true })

// 🟢 Wasabi credentials
const WASABI_BUCKET = 'upward'
const WASABI_REGION = 'us-east-2'
const WASABI_ENDPOINT = 'https://s3.us-east-2.wasabisys.com'
// get your access&secret from Wasabi console
const WASABI_KEY = 'HZOUCM9I2D1MI9HGYL5A'
const WASABI_SECRET = 'wbD9rW8BG08UgX6z19kRa7nc7hzl16vRhEv3TIE6'

// S3 Client for Wasabi
const s3 = new AWS.S3({
  endpoint: WASABI_ENDPOINT,
  region: WASABI_REGION,
  accessKeyId: WASABI_KEY,
  secretAccessKey: WASABI_SECRET,
  signatureVersion: 'v4',
})

// CORS headers
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'OPTIONS, POST, GET',
  'Access-Control-Max-Age': 2592000,
}

// HTTP server
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers)
    res.end()
    return
  }

  if (req.url === '/upload' && req.method.toLowerCase() === 'post') {
    // handle upload
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
        const wasabiKey = `${timestamp}_${safeName}`

        // 1. Generate a Pre-Signed PUT URL (valid for 10 minutes)
        const url = await s3.getSignedUrlPromise('putObject', {
          Bucket: WASABI_BUCKET,
          Key: wasabiKey,
          ContentType: mimetype || 'application/octet-stream',
          Expires: 600,
        })

        // 2. Read file from disk
        const fileData = await fs.readFile(filepath)

        // 3. PUT the file to Wasabi via pre-signed URL
        const resp = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': mimetype || 'application/octet-stream' },
          body: fileData,
        })

        if (!resp.ok) {
          const msg = await resp.text()
          throw new Error(`Wasabi PUT failed: ${resp.status} - ${msg}`)
        }

        // delete temp file
        await fs.unlink(filepath).catch(() => { })

        // Public read URL (if the object is not public, this will 403 to others, but you as owner can always access)
        const wasabiUrl = `${WASABI_ENDPOINT.replace(/^https?:\/\//, `https://${WASABI_BUCKET}.s3.`)}${WASABI_REGION}.wasabisys.com/${wasabiKey}`

        res.writeHead(200, headers)
        res.end(JSON.stringify({
          ok: true,
          wasabi_url: wasabiUrl,
          key: wasabiKey,
          size,
          mimetype,
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
