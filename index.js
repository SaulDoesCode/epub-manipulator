const fs = require('fs').promises,
    path = require('path').posix,
    admzip = require('adm-zip'),
    archiver = require('archiver'),
    cheerio = require('cheerio'),
    dayjs = require('dayjs'),
    rimraf = require('rimraf')


const walk = async (dir, ignoreDirs = true) => {
    let files = await fs.readdir(dir)
    return (await Promise.all(files.map(async file => {
        const filePath = path.join(dir, file)
        const stats = await fs.stat(filePath)
        if (stats.isDirectory()) {
            if (!ignoreDirs) return walk(filePath)
        } else if (stats.isFile()) return filePath
    })))
    .filter(f => f != null)
    .reduce((all, folderContents) => all.concat(folderContents), [])
}

const delFiles = files => new Promise((resolve, reject) => {
    rimraf(files, err => err == null ? resolve() : reject(err))
})

const options = {
    publisher: "somepublisher.com",
    coverImage: path.resolve("./input/cover.jpg").replace(/\\/g, '/'),
    // includeTOCpage: true,
    /* author
    authorListName
    contentPages
    publishDate
    title
    description */
}

const run = async (inputPath = './') => {
try {
    let epubFile, opfFile
    let edgefiles = []
    let contentFiles = []
    let imageFiles = []
    for (const f of (await walk('./input'))) {
        if (f.includes('cover.jpg')) options.coverImage = f
        else if (f.includes('.epub')) epubFile = f
    }

    try {
        await delFiles('./temp/*')
    } catch(e) {
        console.error(e)
    }

    const zip = new admzip("./" + epubFile)
    zip.extractAllTo("./temp", true)

    for (const f of (await walk('./temp', false))) {
        if (f == null || f == '') {
            console.error(`somethin's fishy with a file in ./temp: `, f)
            continue;
        }
        if (f.includes('.opf')) opfFile = f
        else if ((f.includes('.xml') || f.includes('.xhtml') || f.includes('.html'))) {
            if (['cover', 'content', 'contents', 'about', 'title', 'copyright', 'biblio', 'index', 'back', 'ack', 'acknowledgements', 'halftitle', 'dedict', 'feedbooks'].some(ef => f.includes(ef))) {
                edgefiles.push(f)
            } else if (['META-INF', 'metadata.xml', 'container.xml'].some(ef => f.includes(ef))) {
                //  do nothing
            } else {
                contentFiles.push(f)
            }
        } else if (f.includes('images/') && !f.includes('cover') && !f.includes('feedbooks')) {
            imageFiles.push(f)
        }
    }

    for (const f of (await walk('./template/OPS/images', false))) {
        if (f.includes('.')) {
            imageFiles.push(`images/${path.basename(f)}`)
        }
    }

    const $md = cheerio.load(await fs.readFile(opfFile, 'utf8'), {
        normalizeWhitespace: true,
        xmlMode: true
    })

    // options.publisher = $md('dc\\:publisher').text().trim()

    options.publishDate = $md('dc\\:date[opf\\:event="original-publication"]').text().trim()

    options.title = $md('dc\\:title').text().trim()
    options.description = $md('dc\\:description').text().trim()

    options.author = $md('[opf\\:role="aut"]').text()
    if (options.author.includes('http')) {
        options.author = options.author.slice(0, options.author.indexOf('http:')).trim()
    }
    options.imageFiles = imageFiles
    options.contentPages = []
    let cpi = 0
    let fnotes;
    const retrieveContentPage = async p => {
        let fileName = p.split('/')
        fileName = fileName[fileName.length - 1].split('.')[0] + '.xhtml'
        const cp = {file: fileName}
        cpi++

        const $p = cheerio.load(await fs.readFile(p, 'utf8'), {
            normalizeWhitespace: true,
            xmlMode: true
        })

        cp.title = $p('title').text()
        if (cp.title == options.title) {
            cp.title = $p('.chapterHeader').text().trim()
            cp.titleLong = $p('.chapter > h2').text().trim()
            if (cp.titleLong.includes('Chapter ')) {
                try {
                    const afterBit = cp.titleLong.slice(10).trim()
                    if (afterBit.length) {
                        cp.titleLong = cp.titleLong.slice(0, 10) + ' - ' + cp.titleLong.slice(10)
                    }
                } catch (error) {}
            }
        }
        if (cp.title == '') {
            cp.title = $p('.part').text()
        }

        cp.title = cp.title.trim()

        cp.content = $p('body').html().split('.xml').join('.xhtml').trim()

        if (cp.title == '') {
            if (cp.content.includes(`Transcriber's Note:`)) {
                cp.title = `Transcriber's Note:`
            } else {
                cp.title = options.title
            }
        }

        if (p.includes('footnotes')) {
            fnotes = xhtmlSection('Footnotes', cp.content, 'footnotes.xhtml', cp.titleLong, false)
        } else {
            options.contentPages.push(xhtmlSection(cp.title, cp.content, cp.file, cp.titleLong))
        }
    }

    contentFiles.sort((a, b) => {
        try {
            const ia = Number(a.match(/\d+/)[0])
            const ib = Number(b.match(/\d+/)[0])
            if (ia === NaN || ib === NaN) -1
            if (ia > ib) return 1
        } catch (e) {
            if (a.includes('footnote')) return 1
        }
        return -1
    })

    for (const cf of contentFiles) await retrieveContentPage(cf)

    const lastCP = options.contentPages[options.contentPages.length - 1]

    if (lastCP.title == options.title) {
        lastCP.title = 'After Pages'
    }
    if (lastCP.titleLong == options.title) {
        lastCP.titleLong = 'After Pages'
    }

    if (fnotes != null) options.contentPages.push(fnotes)

    if (options.title == '') {
        throw new Error(`Script couldn't scrape a title, this is a loss, womething is wrong`)
    }

    options.aboutPageContent = `<p class="publisher-ad-page"><span><img src="images/RareAudioBooksAd.jpg" style="height:100%;max-width:100%;"/></span></p>`.trim()

    for (const ef of edgefiles) {
        if (!ef.includes('title')) continue;
        try {
            const $t = cheerio.load(await fs.readFile(ef, 'utf8'), {
                normalizeWhitespace: true,
                xmlMode: true
            })
            
            let tr = ($t(`div[style]`).filter((i, el) => {
                if (el.name == 'div') {
                    const t = $t(el).text()
                    return t.includes('Translator')
                }
            }).text() || '').trim()
            if (tr.includes('Translator:') && (tr = tr.slice('(Translator: '.length, -1).trim()) != '') {
                options.translator = tr
                console.log(options.translator)
            }

        } catch(e) {
            console.error(`Couldn't scrape ${ef} file, parsing went wrong, other things should be fine though`)
        }
    }

    await GenEpub(options)    
} catch (e) {
    if (e.code == 'EBUSY') {
        console.log('YOU NEED to close the open ebook.epub file this program created earlier: ', e)
    } else {
        console.log('epub gen had a whoopsie:', e)
    }
    done = true
} finally {
    done = true
}
}

//const zip = new admzip("./input/*.epub")

run()

var done = (function wait() {if (!done) setTimeout(wait, 250)})();

const isEmpty = i => i == null || i == ''

const copyRecursive = async (src, dest) => {
    try{
        const exists = (await fs.access(src)) == null
        const stats = exists && (await fs.stat(src))
        const isDir = exists && stats.isDirectory()
        if (exists && isDir) {
            try {
                await fs.mkdir(dest)
            } catch (e) {
                console.error('mkdir cpyrcrsv:', e)
            }
            for (const childItemName of (await fs.readdir(src))) {
                await copyRecursive(path.join(src, childItemName), path.join(dest, childItemName))
            }
        } else {
            await fs.copyFile(src, dest)
        }
    } catch(e) {
        console.error('copyRecursive error:', e)
    }
}
        
const dc_field = (key, value, id = 'pub_' + key, attr, opfType = key, lang = 'xml:lang="en-us"') => {
    if (isEmpty(key) || isEmpty(value)) return ''
    if (id != null && typeof id !== 'string') {
        [attr, id] = [id, typeof attr === 'string' ? attr : 'pub_' + key]
    }
    const opf_attrs = attr == null || typeof attr === 'string' ?
        '' : Object.entries(attr).map(([type, value]) => value == null
            ? '' : `opf:${type}="${value}"`).join(' ')

    if (value.length < 12 || !isNaN(value) || key == 'date' || key == 'identifier') lang = ''

    return `<dc:${key} ${id != null || id != '' ? 'id="' + id + '"': ''} ${opf_attrs.trim().length != 0 ? opf_attrs : ''} ${lang}>${value}</dc:${key}>`
}

const dc_author = (author, listName) => dc_field('creator', author, 'pub_author', {
    'file-as': listName,
    role: 'aut'
})

const dc_identifier = (identifier, scheme, id = 'primary_id') => dc_field('identifier', identifier, id, {scheme})

const item = (id, fileName, mediaType = 'application/xhtml+xml') => {
    if (typeof fileName != 'string' || !fileName.length) return ''
    const fnsplit = fileName.split('.')
    let ext = fnsplit[fnsplit.length - 1]
    if (ext == 'xhtml' || ext == 'xml') {
        mediaType = 'application/xhtml+xml'
    } else if (ext == 'css') {
        mediaType = 'text/css'
    } else if (ext == 'ncx') {
        mediaType = 'application/x-dtbncx+xml'
    } else {
        const imageTypes = ['png', 'jpg', 'jpeg']
        if (imageTypes.includes(ext)) {
            if (ext == 'jpg') ext = 'jpeg'
            mediaType = 'image/' + ext
        }
    }

    return `<item id="${id}" href="${fileName}" media-type="${mediaType}" />`
}

const itemref = (idref, linear = true) => `<itemref idref="${idref}" linear=${linear ? '"yes"' : '"no"'}/>`

const reference = (title, href, type = 'text') => `<reference type="${type}" title="${title}" href="${href}"/>`

const navPoint = (playOrder, text, contentSrc, contentSrcID = '', id = playOrder, idPrefix = 'content') => {
    if (typeof contentSrc === 'string' && contentSrcID != '' && !contentSrc.includes('#')) {
        if (!contentSrcID.includes('#')) contentSrcID = '#' + contentSrcID
        contentSrc = contentSrc + contentSrcID
    }
    return `<navPoint id="${idPrefix}${id}" playOrder="${playOrder}"><navLabel><text>${text}</text></navLabel><content src="${contentSrc}"/></navPoint>`
}

const navPoints = (sections = [], playOrder = 0) => sections.map(
    ({title, titleLong, file, headingID, id}) =>
    navPoint(playOrder++, titleLong != null && titleLong.length ? titleLong : title, file, headingID, id)
).join('\n')

const GenEpub = async ({
    author,
    authorLink,
    authorBirthDate,
    authorDeathDate,
    authorDesc,
    aboutPageContent,
    authorListName = author.split(' ').reverse().join(', '),
    contentPages = [],
    imageFiles = [],
    identifiers = [
        {
            identifier: generateUUID(),
            scheme: 'uuid'
        }
    ],
    identifierPrimaryID = 'primary_id',
    modificationDate = dayjs().format('YYYY-MM-DD'),
    publishDate,
    publisher,
    publisherSlogan,
    publisherLogo,
    coverImage,
    rights = 'Public Domain',
    translator,
    title,
    description,
    contentDepth = 1,
    totalPageCount = 0,
    maxPageNumber = totalPageCount,
    lang = 'en',
    outputPath = `./output/ebook.epub`,
    includeTOCpage = false
}) => {

    const hasAboutPage = typeof aboutPageContent == 'string' && aboutPageContent.length

    let identifier_count = 1
    let primaryUsed = false
    let primaryIdentifier
    identifiers = identifiers.map(({
        identifier,
        scheme
    }) => {
        const id = dc_identifier(identifier, scheme, primaryUsed ? `identifier_${identifier_count++}` : identifierPrimaryID)
        if (!primaryUsed) {
            primaryIdentifier = {identifier, scheme}
            primaryUsed = true
        }
        return id
    }).join('\n')

    const opf = `
<?xml version="1.0" encoding="UTF-8" ?>
<package version="2.0" unique-identifier="${identifierPrimaryID}" xmlns="http://www.idpf.org/2007/opf">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dcterms="http://purl.org/dc/terms/">
${dc_field('title', title)}
${identifiers}
${dc_author(author, authorListName)}
${dc_field('publisher', publisher)}
<dc:language xsi:type="dcterms:RFC4646">${lang}</dc:language>
${dc_field('description', description)}
${dc_field('rights', rights)}
${dc_field('date', publishDate, 'original-publication', {event:'original-publication'})}
${dc_field('date', publishDate, 'creation', {event:'creation'})}
${dc_field('date', modificationDate, 'publication', {event:'ops-publication'})}
${dc_field('date', modificationDate, 'modification', {event:'modification'})}
<meta name="cover" content="book-cover"/>
</metadata>
<manifest>
${item('cover', 'cover.xhtml')}
${item('titlepage', 'title.xhtml')}
${hasAboutPage ? item('about', 'about.xhtml') : ''}
${includeTOCpage ? item('contents', 'contents.xhtml') : ''}
${item('copyright', 'copyright.xhtml')}
${item('endpage', 'endpage.xhtml')}

${contentPages.map(cp => item(cp.file.split('.')[0], cp.file)).join('\n')}

${item('main-stylesheet', 'css/main.css')}

${imageFiles.map(imgf => item(path.basename(imgf).split('.')[0], imgf)).join('\n')}

${item('publisher-logo', publisherLogo)}
${item('book-cover', 'images/cover.jpg')}
${item('ncx', 'toc.ncx')}
</manifest>
<spine toc="ncx">
${itemref('cover')}
${itemref('titlepage')}
${itemref('copyright')}
${hasAboutPage ? itemref('about') : ''}
${includeTOCpage ? itemref('contents') : ''}

${contentPages.map(cp => itemref(cp.file.split('.')[0], cp.linear)).join('\n')}

${itemref('endpage')}

</spine>
<guide>
${reference('Cover', 'cover.xhtml', 'cover')}
${reference('Title Page', 'title.xhtml', 'title-page')}
${reference(publisher, 'copyright.xhtml', 'copyright')}
${hasAboutPage ? reference('About', 'about.xhtml', 'bibliography') : ''}
${includeTOCpage ? reference('Contents', 'contents.xhtml', 'toc') : ''}

${contentPages.map(cp => reference(cp.title, cp.file)).join('\n')}

${reference('End Page', 'endpage.xhtml')}

</guide>
</package>`.trim()

    const tocNCX = `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="en">
<head>
<meta name="dtb:uid" content="${primaryIdentifier.identifier}"/>
<meta name="dtb:depth" content="${contentDepth}"/>
<meta name="dtb:totalPageCount" content="${totalPageCount}"/>
<meta name="dtb:maxPageNumber" content="${maxPageNumber}"/>
</head>
<docTitle><text>${title}</text></docTitle>
<docAuthor><text>${authorListName}</text></docAuthor>
<navMap>
${navPoints([
    {file: 'title.xhtml', title: 'Title'},
    ...contentPages
])}
</navMap>
</ncx>`.trim()

    const titlePage = xhtmlSection('Title Page', `
<div style="text-align:center; display: block; width: 100%; height: 100%; page-break-after: always;">
    <div class="title-page">
        <h1>${title}</h1>
        <h2>${author}</h2>
    </div>
    <div class="title-page-info">
        <div class="tp-data"><span>${dayjs(publishDate).format('YYYY')}</span></div>
        <div class="tp-data"><span>${publisher}</span></div>
        ${translator != null && translator.length ? (t => (console.log(t), t))('<div class="tp-data"><span>Translated by</span><br/><span>' + translator + '</span></div>') : ''}
    </div>
</div>`.trim(), './output/ebook/OPS/title.xhtml').content

/* 
<div class="tp-data"><span><b>Publisher</b></span>: <span>${publisher}</span></div>
<div class="tp-data"><span><b>Current Publication Date</b></span>: <span>${modificationDate}</span></div>
` + (
        !(publisherLogo && publisherLogo.length) ? '' : `<div class="publisher-logo"><img src="images/${publisherLogo}" alt="${publisher}" title="${publisher}"/></div>`
    ) + (
        !(publisherSlogan && publisherSlogan.length) ? '' : `<p class="publisher-slogan">${publisherSlogan}</p>`
    ) + `

*/

    const copyrightPage = xhtmlSection('Copyright', `
        <div class="copyright-page">
            <p>${rights}</p>
        </div>
    `.trim(), 'copyright.xhtml').content

    const coverPage = `
<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head>
   <title>Cover</title>
   <meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8"/>
  </head>
  <body>
    <div style="text-align: center; page-break-after: always;">
      <img src="images/cover.jpg" alt="Cover" style="height: 100%; max-width: 100%;"/>
    </div>
  </body>
</html>`.trim()

    const endPage = xhtmlSection('Endpage', `
        <div class="end-page"><span>
        <img src="images/RareAudioBooksAd.jpg" width="544" height="767"/>
        </span></div>
    `.trim(), 'endpage.xhtml').content

/*`<p>
    <span class="end-page-title"><b>${title}</b></span><br/>
    brought to you by
    <span class="end-page-publisher"><b>${publisher}</b></span>
</p>`*/

    await delFiles('./output/*')
    try {
        await fs.mkdir('./output')
        await fs.mkdir('./output/ebook')
    } catch (e) {
        if (e.code != 'EEXIST') console.error(`mkdir output & output/ebook, had some trouble:`, e)
    }
    await copyRecursive('./template', './output/ebook')
    await copyRecursive(coverImage, './output/ebook/OPS/images/cover.jpg')

    // await fs.writeFile('./output/ebook/mimetype', 'application/epub+zip')
    await fs.writeFile('./output/ebook/OPS/content.opf', opf)
    await fs.writeFile('./output/ebook/OPS/cover.xhtml', coverPage)
    if (includeTOCpage) {
        const contentsPageEntry = ({
            title,
            file,
            id
        }, count) => `<p class="contents-entry" id="${id && id.length ? id : 'toc-' + count}"><span><a href="${file}">${title}</a></span></p>`

        let cpEntriesCount = 0
        const contentsPageEntries = `
        <h1 style="margin:.5em auto;border-bottom:2px solid hsl(0,0%,33%);">C<small>ontents</small></h1>
        ${[
            {
                title: 'Cover Page',
                file: 'cover.xhtml'
            },
            {
                title: 'Title Page',
                file: 'title.xhtml'
            },
            hasAboutPage ? {
                title: 'About',
                file: 'about.xhtml'
            } : null,
            {
                title: 'Copyright',
                file: 'copyright.xtml'
            }
        ].concat(contentPages)
        .concat([
            {
                title: 'End Page',
                file: 'endpage.xhtml'
            }
        ])
        .filter(cp => cp != null)
        .map(cp => contentsPageEntry(cp, cpEntriesCount++)).join('\n')}
    `.trim()

        const contentsPage = xhtmlSection('Contents', contentsPageEntries, 'contents.xhtml').content

        await fs.writeFile('./output/ebook/OPS/contents.xhtml', contentsPage)
    }
    await fs.writeFile('./output/ebook/OPS/title.xhtml', titlePage)
    await fs.writeFile('./output/ebook/OPS/copyright.xhtml', copyrightPage)
    await fs.writeFile('./output/ebook/OPS/endpage.xhtml', endPage)

    if (hasAboutPage) {
        const aboutPage = xhtmlSection('About', aboutPageContent).content
        await fs.writeFile('./output/ebook/OPS/about.xhtml', aboutPage)
    }

    await fs.writeFile('./output/ebook/OPS/toc.ncx', tocNCX)

    for (const {file, content} of contentPages) {
        await fs.writeFile(path.join('./output/ebook/OPS/', file), content)
    }

    await delFiles('./output/*/output')

    await (new Promise((resolve, reject) => {
        const archive = archiver("zip", {zlib: {level: 9}})
        const streamOut = require('fs').createWriteStream('./output/ebook.epub')
        console.log("Zipping temp dir to", './output/ebook.epub')
        archive.append("application/epub+zip", {
            store: true,
            name: "mimetype"
        })
        archive.directory("./output/ebook/META-INF", "META-INF")
        archive.directory("./output/ebook/OPS", "OPS")
        archive.pipe(streamOut)
        archive.on("end", () => {
            console.log(`Sucess? Probably. Go look in ${outputPath || 'the output folder/path'}`)
            resolve()
        })
        archive.on("error", err => {
            reject(err)
        })
        archive.finalize()
    }))
    
    console.log("Done zipping, clearing temp dir...");
    await delFiles('./output/ebook/')
}

const xhtmlSection = (title, content, file, titleLong, linear = true, lang = 'en') => ({
    title,
    titleLong,
    file,
    linear,
    content: `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xml:lang="${lang}" xmlns="http://www.w3.org/1999/xhtml">
<head>
    <title>${titleLong != null && titleLong.length ? titleLong : title}</title>
    <meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8" />
    <link rel="stylesheet" type="text/css" href="css/main.css"/>
</head>
<body>
${content}
</body>
</html>`.trim()

})

/**
 * Fast UUID generator, RFC4122 version 4 compliant.
 * @author Jeff Ward (jcward.com).
 * @license MIT license
 * @link http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript/21963136#21963136
 **/
const generateUUID = (() => {
  let lut = []
  for (let i=0; i<256; i++) lut[i] = (i<16?'0':'')+(i).toString(16)
  return () => {
    let d0 = Math.random()*0xffffffff|0
    let d1 = Math.random()*0xffffffff|0
    let d2 = Math.random()*0xffffffff|0
    let d3 = Math.random()*0xffffffff|0
    return lut[d0&0xff]+lut[d0>>8&0xff]+lut[d0>>16&0xff]+lut[d0>>24&0xff]+'-'+
      lut[d1&0xff]+lut[d1>>8&0xff]+'-'+lut[d1>>16&0x0f|0x40]+lut[d1>>24&0xff]+'-'+
      lut[d2&0x3f|0x80]+lut[d2>>8&0xff]+'-'+lut[d2>>16&0xff]+lut[d2>>24&0xff]+
      lut[d3&0xff]+lut[d3>>8&0xff]+lut[d3>>16&0xff]+lut[d3>>24&0xff]
  }
})()