#!/usr/bin/env node

const fs = require('fs-extra')
const path = require('path')
const { Command } = require('commander')
const nodemailer = require('nodemailer')
const https = require('https')

const DEFAULT_FEEDS = [
    'https://news.google.com/rss/search?q=artificial%20intelligence%20plush%20toy%20industry&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=AI%20plush%20toy%20manufacturing&hl=en-US&gl=US&ceid=US:en',
]

const DEFAULT_KEYWORDS = [
    'plush',
    'stuffed toy',
    'soft toy',
    'teddy',
    'AI',
    'artificial intelligence',
]

const program = new Command()

program
    .name('news-watcher')
    .description('Fetch AI plush toy industry news and email updates immediately.')
    .option(
        '-c, --config <path>',
        'Path to config JSON',
        path.join(__dirname, 'news-watcher.config.json')
    )

const fetchUrl = async (url) => {
    if (typeof fetch === 'function') {
        const response = await fetch(url)
        if (!response.ok) {
            throw new Error(`Failed to fetch ${url}: ${response.status}`)
        }
        return await response.text()
    }

    return new Promise((resolve, reject) => {
        https
            .get(url, (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(
                        new Error(
                            `Failed to fetch ${url}: ${res.statusCode}`
                        )
                    )
                    return
                }
                const chunks = []
                res.on('data', (chunk) => chunks.push(chunk))
                res.on('end', () => resolve(Buffer.concat(chunks).toString()))
            })
            .on('error', reject)
    })
}

const stripCdata = (value) =>
    value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()

const parseItems = (xml) => {
    const items = []
    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || []

    for (const item of itemMatches) {
        const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/)
        const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/)
        const guidMatch = item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)
        const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)
        const descMatch = item.match(/<description>([\s\S]*?)<\/description>/)

        const title = titleMatch ? stripCdata(titleMatch[1]) : 'Untitled'
        const link = linkMatch ? stripCdata(linkMatch[1]) : ''
        const guid = guidMatch ? stripCdata(guidMatch[1]) : link || title
        const published = dateMatch ? stripCdata(dateMatch[1]) : ''
        const description = descMatch ? stripCdata(descMatch[1]) : ''

        items.push({ title, link, guid, published, description })
    }

    return items
}

const normalize = (value) => value.toLowerCase()

const matchesKeywords = (item, keywords) => {
    const haystack = `${item.title} ${item.description}`.toLowerCase()
    return keywords.some((keyword) => haystack.includes(normalize(keyword)))
}

const loadConfig = async (configPath) => {
    const exists = await fs.pathExists(configPath)
    if (!exists) {
        throw new Error(
            `Config not found at ${configPath}. Use the sample file to get started.`
        )
    }

    const config = await fs.readJson(configPath)
    return {
        feeds: config.feeds?.length ? config.feeds : DEFAULT_FEEDS,
        keywords: config.keywords?.length ? config.keywords : DEFAULT_KEYWORDS,
        smtp: config.smtp,
        recipients: config.recipients,
        cachePath:
            config.cachePath || path.join(__dirname, '.news-watcher-cache.json'),
    }
}

const loadCache = async (cachePath) => {
    const exists = await fs.pathExists(cachePath)
    if (!exists) {
        return { seen: [] }
    }

    return await fs.readJson(cachePath)
}

const saveCache = async (cachePath, cache) => {
    await fs.outputJson(cachePath, cache, { spaces: 2 })
}

const sendEmail = async (smtp, recipients, items) => {
    if (!smtp || !recipients?.length) {
        throw new Error('SMTP settings and recipients are required to send email.')
    }

    const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: {
            user: smtp.user,
            pass: smtp.pass,
        },
    })

    const subject = `AI Plush Toy Industry News (${items.length} new)`
    const lines = items.map((item) =>
        [
            `Title: ${item.title}`,
            item.published ? `Published: ${item.published}` : null,
            item.link ? `Link: ${item.link}` : null,
            '',
        ]
            .filter(Boolean)
            .join('\n')
    )

    const text = [
        'New AI + plush toy industry updates found:',
        '',
        ...lines,
    ].join('\n')

    await transporter.sendMail({
        from: smtp.from,
        to: recipients.join(','),
        subject,
        text,
    })
}

const main = async () => {
    program.parse(process.argv)
    const { config: configPath } = program.opts()

    const config = await loadConfig(configPath)
    const cache = await loadCache(config.cachePath)

    const newItems = []

    for (const feed of config.feeds) {
        const xml = await fetchUrl(feed)
        const items = parseItems(xml)
        for (const item of items) {
            if (!matchesKeywords(item, config.keywords)) {
                continue
            }

            if (!cache.seen.includes(item.guid)) {
                newItems.push(item)
                cache.seen.push(item.guid)
            }
        }
    }

    if (newItems.length === 0) {
        console.log('No new matching items found.')
        return
    }

    await sendEmail(config.smtp, config.recipients, newItems)
    await saveCache(config.cachePath, cache)

    console.log(`Sent ${newItems.length} new items.`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
