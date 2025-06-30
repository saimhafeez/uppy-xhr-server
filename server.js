#!/usr/bin/env node

import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import fs from 'node:fs/promises'
import formidable from 'formidable'
import fetch from 'node-fetch' // npm install node-fetch

const UPLOAD_DIR = new URL('./uploads/', import.meta.url)
await mkdir(UPLOAD_DIR, { recursive: true })

const BUCKET = 'upwardlibrary' // <-- your bucket name
const REGION = 'us-east-1'     // <-- your AWS (or Wasabi) region (if different, change!)
const PUBLIC_BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com/`

http.createServer(async (req, res) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'OPTIONS, POST, GET',
    'Access-Control-Max-Age': 2592000, // 30 days
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers)
    res.end()
    return
  }

  if (req.url === '/upload' && req.method.toLowerCase() === 'post') {
    // Parse the upload form data
    const form = formidable({
      keepExtensions: true,
      uploadDir: fileURLToPath(UPLOAD_DIR),
    })

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error('Upload err:', err)
        res.writeHead(500, headers)
        res.end(JSON.stringify({ error: err.message }))
        return
      }

      try {
        // Expecting field name 'file' (Uppy default)
        const uploaded = (files.file && files.file[0]) || files[Object.keys(files)[0]][0]
        const { filepath, originalFilename, mimetype, size } = uploaded
        // Compose a unique filename
        const timestamp = Date.now()
        const safeName = originalFilename.replace(/[^\w.\-]/g, '_')
        const s3Filename = `${timestamp}_${safeName}`
        const s3Url = PUBLIC_BASE + s3Filename

        // Read file as Buffer
        const fileData = await fs.readFile(filepath)
        // PUT to S3
        const s3Resp = await fetch(s3Url, {
          method: 'PUT',
          headers: {
            'Content-Type': mimetype || 'application/octet-stream',
            'Content-Length': size
          },
          body: fileData
        })

        if (!s3Resp.ok) {
          const msg = await s3Resp.text()
          throw new Error(`S3 PUT failed: ${s3Resp.status} - ${msg}`)
        }

        // Optionally: remove temp file from disk
        await fs.unlink(filepath).catch(() => { })

        res.writeHead(200, headers)
        res.end(JSON.stringify({
          ok: true,
          s3url: s3Url,
          filename: s3Filename,
          size,
          mimetype,
        }))
      } catch (e) {
        console.error('Failed to upload to S3:', e)
        res.writeHead(500, headers)
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }

  // Not Found
  res.writeHead(404, headers)
  res.end(JSON.stringify({ error: 'Not found' }))
}).listen(3020, () => {
  console.log('server started on http://localhost:3020')
})
