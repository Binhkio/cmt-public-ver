const express = require('express')
const fs = require('fs');
const fsEx = require('fs-extra');
const request = require('request');
const app = express()
const cloudscraper = require('cloudscraper');
const CryptoJS = require('crypto-js')
const cheerio = require('cheerio')
const http = require('http');
const moment = require('moment');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const mysql = require('mysql')
const path = require('path');
const errorHandler = require('errorhandler')
app.use(express.json())
app.use(express.static(path.join(__dirname, '/')));
const PORT = process.env.PORT || 8080;
const dirPath = "./data"

app.use(errorHandler({ dumpExceptions: true, showStack: true }))
process
    .on('unhandledRejection', (reason, p) => {
        console.log("Reason", reason, "Promise", p)
    })
    .on('uncaughtException', err => {
        console.log("uncaughtException", err)
    })

var CURRENT_DOMAIN = ""

if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data');
}
if (!fs.existsSync('./data/zinmanga')) {
    fs.mkdirSync('./data/zinmanga');
}
if (!fs.existsSync('./data/bato')) {
    fs.mkdirSync('./data/bato');
}

const sleep = (milliseconds) => {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function addslashes(string) {
    return string.replace(/\\/g, '\\\\').
        replace(/\u0008/g, '\\b').
        replace(/\t/g, '\\t').
        replace(/\n/g, '\\n').
        replace(/\f/g, '\\f').
        replace(/\r/g, '\\r').
        replace(/'/g, '\\\'').
        replace(/"/g, '\\"');
}

const getLinksImageByChapter = async (linkChapter) => {
    const htmlChapter = await cloudscraper.get(linkChapter)
    $ = cheerio.load(htmlChapter);

    function findTextAndReturnRemainder(target, variable) {
        const chopFront = target.substring(target.search(variable) + variable.length, target.length);
        const result = chopFront.substring(0, chopFront.search(";"));
        return result;
    }
    const text = $($('script')).text();
    let findAndClean = findTextAndReturnRemainder(text, "const imgHttpLis =");
    const imgHttpLis = JSON.parse(findAndClean);
    findAndClean = findTextAndReturnRemainder(text, "const batoPass =");
    const batoPass = findAndClean
    findAndClean = findTextAndReturnRemainder(text, "const batoWord =");
    const batoWord = JSON.parse(findAndClean);
    const imgWordLis = JSON.parse(CryptoJS.AES.decrypt(batoWord, eval(batoPass)).toString(CryptoJS.enc.Utf8))
    let imageLinks = imgHttpLis.map((item, index) => item + "?" + imgWordLis[index])
    return imageLinks
}

function delay(ms) {
    return new Promise(res => {
        setTimeout(res(true), ms);
    })
}

var errorImages = 0

const downloadImageByLink = async (uri, filename, callback) => {
    uri = uri.slice(uri.indexOf("http"))
    await delay(1000)
    await new Promise((resolve, reject) => {
        // console.log("Start download " + uri)
        cloudscraper.get({
            uri: uri,
            headers: {
                'referer': 'https://zinmanga.com/'
            },
            timeout: 10000,
            agent: false,
            pool: {
                maxSockets: 50
            }
        }).on('timeout', (err) => {
            console.log("timeout error: " + err);
        })
            .on('error', (error) => {
                console.error("request error: " + error);
                errorImages++;
                fsEx.remove(filename, err => {
                    if (err) console.log("Error while deleting file: ", err)
                    else console.log("Deleted ", filename)
                })
                reject(error)
            })
            .pipe(fs.createWriteStream(filename))
            .on('finish', async () => {
                // console.log("Finish download " + uri)
                callback()
                resolve();
            })
    })
        .catch((error) => {
            console.log(`Something happened: ${error}`);
        });
}

app.get('/', (req, res) => {
    return res.render(path.join(__dirname + '/index.html'))
})
app.get('/detail', (req, res) => {
    return res.sendFile(__dirname + '/detail.html')
})

app.post('/check', async (req, res) => {
    // [{url: "", numOfchapters: }, {url: "", numOfchapters: }]
    const data = req.body
    const ans = []
    const dirPath = './data'
    try {
        // crawl num of chap for each url
        const dataLen = data.length
        for (let i = 0; i < dataLen; ++i) {
            // count in web
            const url = data[i].url
            const html = await cloudscraper.get(data[i].url)
            let $ = cheerio.load(html);
            let chapterEle;
            let web;
            let name;
            let chapterNameWeb = []

            if (url.includes("bato")) {
                chapterEle = $("a[href^='/chapter']:has(b)")
                web = "bato"
                name = url.split('/').slice(-1)[0]
                for (let index = 0; index < chapterEle.length; index++) {
                    chapterNameWeb.push(chapterEle.eq(index).text().trim().replace(/[/\\:?<>|\"]+/g, "").replace(/\s\s+/g, ' '))
                }
            } else if (url.includes("zinmanga")) {
                chapterEle = $("li.wp-manga-chapter > a")
                web = "zinmanga"
                name = url.split('/')[url.split('/').findIndex((item) => item === 'manga') + 1]
                for (let index = 0; index < chapterEle.length; index++) {
                    chapterNameWeb.push(chapterEle.eq(index).text().trim().replace(/[/\\:?<>|\"]+/g, "").replace(/\s\s+/g, ' ').replaceAll("\\n", ""))
                }
            }

            // count in server
            let chapterNameServer = fs.readdirSync(`${dirPath}/${web}/${name}`)
            chapterNameServer.pop() // cut file url.txt
            chapterNameServer.pop() // cut file thumbnail.png
            const chaptersHasImage = chapterNameServer.filter(item => {
                const chapterImages = fs.readdirSync(`${dirPath}/${web}/${name}/${item}`)
                return chapterImages.length !== 0
            }) // filter 0 image chapter
            const totalChapters = chaptersHasImage.length
            // download new chap folder
            chapterNameWeb.reverse()
            if (chapterNameWeb.length > chapterNameServer.length) {
                chapterNameWeb.forEach((item, index) => {
                    if (index >= data[i].numOfChapters) {
                        if (chapterNameServer.includes(item) === false) {
                            if (!fs.existsSync(`${dirPath}/${web}/${name}/${item}`)) {

                                fs.mkdirSync(`${dirPath}/${web}/${name}/${item}`)
                            }
                        }
                    }
                })
            }

            ans.push({
                ...data[i],
                allChapter: totalChapters,
                newChapter: chapterEle.length - totalChapters - data[i].numOfChapters
            })
        }
        return res.status(200).json({ message: "success", data: ans })
    } catch (error) {
        console.log(error)
        return res.status(500).json({ message: "Server error", data: [] })
    }
})

app.post('/delete', (req, res) => {
    const { url, name } = req.body
    if (url.includes('bato')) {
        deleteFile("./data/bato/" + name, (success) => {
            let data = JSON.parse(fs.readFileSync("./map.json").toString())
            delete data[name]
            fs.writeFileSync('map.json', JSON.stringify(data))
            return res.send({ success: success })
        })
    } else if (url.includes('zinmanga')) {
        deleteFile("./data/zinmanga/" + name, (success) => {
            let data = JSON.parse(fs.readFileSync("./map.json").toString())
            delete data[name]
            fs.writeFileSync('map.json', JSON.stringify(data))
            return res.send({ success: success })
        })
    }
})

app.post('/delete-chapter', (req, res) => {
    const { path } = req.body
    console.log("Delete: ", path);
    deleteFile(path, (success) => {
        return res.send({ success: success })
    })

})


function deleteAll(postId) {
    const chapterIdSql = `SELECT \`chapter_id\` FROM \`${DB_PREFIX}_manga_chapters\` WHERE \`post_id\` = '${postId}'`
    database.query((chapterIdSql), (err, results) => {
        if (err) {
            console.log(err)
            return res.send({ success: false, message: "(delete) Get chapter id failed" })
        }
        if (results.length > 0) {
            results.forEach((result, index) => {
                const dataSql = `DELETE FROM \`${DB_PREFIX}_manga_chapters_data\` WHERE \`chapter_id\` = \"${result.chapter_id}\";`
                database.query((dataSql), err => {
                    if (err) {
                        console.log(err)
                        return res.send({ success: false, message: "Delete chapter data failed" })
                    }
                })
            })
        }
    })
    const chapterSql = `DELETE FROM \`${DB_PREFIX}_manga_chapters\` WHERE \`post_id\` = \"${postId}\";`
    database.query((chapterSql), err => {
        if (err) {
            console.log(err)
            return res.send({ success: false, message: "Delete chapter failed" })
        }
    })
    const postSql = `DELETE FROM \`${DB_PREFIX}_posts\` WHERE \`ID\` = \"${postId}\"`
    database.query((postSql), err => {
        if (err) {
            console.log(err)
            return res.send({ success: false, message: "Delete post failed" })
        }
    })
}

function insertPosts(description, title, slug, chapters, path, res) {
    const checkIdSql = `SELECT \`ID\` FROM \`${DB_PREFIX}_posts\` WHERE \`post_name\` LIKE '${slug}'`
    database.query((checkIdSql), (err, result) => {
        if (err) {
            console.log(err)
            return res.send({ success: false, message: "Select post id failed" })
        }
        if (result.length > 0) {
            deleteAll(result[result.length - 1].ID)
        }
        pathThumbnail = `${CURRENT_DOMAIN}\/data\/${path.split('/')[2]}\/${slug}\/thumbnail.png`
        const insertSql = `INSERT INTO \`${DB_PREFIX}_posts\`(\`post_content\`, \`post_title\`, \`post_excerpt\`, \`post_name\`, \`to_ping\`, \`pinged\`, \`post_content_filtered\`, \`post_type\`) VALUES(\"${description}\", \"${title}\", \"${pathThumbnail}\", \"${slug}\", \"\", \"\", \"\",\"wp-manga\")`
        database.query((insertSql), (err, result) => {
            if (err) {
                console.log(err)
                return res.send({ success: false, message: "Insert post failed" })
            }
            console.log("Upload to table Posts...")
            database.query((checkIdSql), (err, result) => {
                if (err) {
                    console.log(err)
                    return res.send({ success: fals, message: "Select post id after insert failed" })
                }
                insertMangaChapters(result[result.length - 1].ID, slug, chapters, path, res)
            })
        })
    })
}

function insertMangaChapters(postId, mangaSlug, chapters, path, res) {
    const sql = `INSERT INTO \`${DB_PREFIX}_manga_chapters\` (\`post_id\`, \`volume_id\`, \`chapter_name\`, \`chapter_name_extend\`, \`chapter_slug\`) VALUES `
    const values = chapters.map(chapter => {
        const slug = chapter.toLowerCase().replace(/\s\s+/g, ' ').replaceAll(" ", "-");
        return `(\"${postId}\", \"0\", \"${chapter}\", \"\", \"${slug}\")`
    }).join(",")
    database.query((sql + values), (err) => {
        if (err) {
            console.log(err)
            return res.send({ success: false, message: "Insert chapters failed" })
        }
        console.log("Upload to table Manga Chapters...")
    })

    const getIdSql = `SELECT \`chapter_id\` FROM \`${DB_PREFIX}_manga_chapters\` WHERE \`post_id\` = \"${postId}\"`
    database.query((getIdSql), (err, result) => {
        if (err) {
            console.log(err)
            return res.send({ success: false, message: "Select chapter after insert failed" })
        }
        const chapterIDs = result.map((val) => val.chapter_id)
        insertMangaChaptersData(chapterIDs, chapters, mangaSlug, path, res)
    })
}

function insertMangaChaptersData(chapterIDs, chapters, mangaSlug, path, res) {
    const sql = `INSERT INTO \`${DB_PREFIX}_manga_chapters_data\` (\`chapter_id\`, \`storage\`, \`data\`) VALUES `
    const values = chapterIDs.map((chapterId, chapterIdx) => {
        const images = fs.readdirSync(`${path}/${chapters[chapterIdx]}`).sort((a, b) => {
            const item1 = parseInt(a.split("_")[0])
            const item2 = parseInt(b.split("_")[0])
            return item1 - item2
        })
        // console.log("Image: ", images)
        const data = "{" + images.map((img, imgIdx) => {
            const mime = img.split(".").pop()
            return `\"${imgIdx}\":{\"src\":\"${CURRENT_DOMAIN}\/data\/${path.split('/')[2]}\/${mangaSlug}\/${chapters[chapterIdx].replace("-", "\-")}\/${img}\",\"mime\":\"image\/${mime}\"}`
        }).join(",") + "}"
        return `('${chapterId}', 'local', \'${data}\')`
    }).join(",")
    database.query((sql + values), (err) => {
        if (err) {
            console.log(err)
            return res.send({ success: false, message: "Insert chapter data failed" })
        }
        console.log("Upload to table Manga Chapters Data...")
        database.end(function (err) {
            if (err) {
                return console.log('End db error:' + err.message);
            }
            console.log("Disconnected to database...\n-----------------")
        })

        return res.send({ success: true, message: "Insert successed" })
    })
}
var database
var databaseConfig = {
    host: "67.205.186.98",
    user: "mangastictk_YTM1YjAzYjRiZmFmYW_username",
    password: "ZTU3YWQ1NTkxMzFhM2VlMzFiMWU1MmRmMjUx",
    database: "mangastictk_YTM1YjAzYjRiZmFmYW_dbname",
    port: 18188
}
var databaseConfig2 = {
    host: "67.205.186.98",
    user: "mangastictk_YTM1YjAzYjRiZmFmYW_username",
    password: "ZTU3YWQ1NTkxMzFhM2VlMzFiMWU1MmRmMjUx",
    database: "mangastictk_YTM1YjAzYjRiZmFmYW_dbname",
    port: 18188
}
var DB_PREFIX = "YjdlN2"


app.post('/upload', async (req, res) => {
    try {
        // DB Connecttion
        database = mysql.createConnection(databaseConfig);

        const dirPath = './data'
        const { url, name, domain } = req.body
        CURRENT_DOMAIN = domain
        const source = url.includes("bato") ? "bato" : url.includes("zinmanga") ? "zinmanga" : ""
        const html = await cloudscraper.get(url)
        const $ = cheerio.load(html)
        const title = source === "bato" ? $(".item-title>a").text() : source === "zinmanga" ? $(".post-title>h1").text() : "Unknown"

        let summary = ""
        if (source === "bato") {
            summary = $("#limit-height-body-summary > .limit-html").text()
        } else if (source === "zinmanga") {
            summary = $(".summary__content > p").text()
        }
        const chapters = fs.readdirSync(`${dirPath}/${source}/${name}`)
        chapters.pop() // cut file url.txt
        chapters.pop() // cut file thumbnail.png
        try {
            insertPosts(summary, title, name, chapters, `${dirPath}/${source}/${name}`, res)
        } catch (err) {
            console.log(err)
            return res.send({ success: false, message: "Try catch failed" })
        }
    } catch (err) {
        console.log(err)
        return res.send({ success: false, message: "Try catch failed" })
    }
})

function insertEachMangaChapter(res, postSlug, chapterName, path) {
    const getPostIdSql = `SELECT \`ID\` FROM \`${DB_PREFIX}_posts\` WHERE \`post_name\` = \"${postSlug}\"`
    database.query((getPostIdSql), (err, results) => {
        if (err) {
            console.log("Get postID failed", err)
            return res.send({ success: false, message: "Get postID failed" })
        }
        const postId = results[0].ID

        const slug = chapterName.toLowerCase().replace(/\s\s+/g, ' ').replaceAll(" ", "-");
        const sql = `INSERT INTO \`${DB_PREFIX}_manga_chapters\` (\`post_id\`, \`volume_id\`, \`chapter_name\`, \`chapter_name_extend\`, \`chapter_slug\`) VALUES (\"${postId}\", \"0\", \"${chapterName}\", \"\", \"${slug}\")`

        database.query((sql), (err) => {
            if (err) {
                console.log("Insert chapter failed", err)
                return res.send({ success: false, message: "Insert chapter failed" })
            }
            console.log("Upload to table Manga Chapters...")

            const getIdSql = `SELECT \`chapter_id\` FROM \`${DB_PREFIX}_manga_chapters\` WHERE \`post_id\` = \"${postId}\" AND \`chapter_name\` = \"${chapterName}\"`
            database.query((getIdSql), (err, results) => {
                if (err) {
                    console.log("Get chapterID failed", err)
                    return res.send({ success: false, message: "Get chapterID failed" })
                }
                const images = fs.readdirSync(`./${path}`).sort((a, b) => {
                    const item1 = parseInt(a.split("_")[0])
                    const item2 = parseInt(b.split("_")[0])
                    return item1 - item2
                })
                // console.log("Image: ", images)
                const data = "{" + images.map((img, imgIdx) => {
                    const mime = img.split(".").pop()
                    return `\"${imgIdx}\":{\"src\":\"${CURRENT_DOMAIN}\/${path.replace('-', '\-')}\/${img}\",\"mime\":\"image\/${mime}\"}`
                }).join(",") + "}"

                const insertDataSql = `INSERT INTO \`${DB_PREFIX}_manga_chapters_data\` (\`chapter_id\`, \`storage\`, \`data\`) VALUES (\'${results[0].chapter_id}\', \'local\', \'${data}\')`

                database.query((insertDataSql), (err) => {
                    if (err) {
                        console.log(err)
                        return res.send({ success: false, message: "Insert chapter data failed" })
                    }
                    console.log("Upload to table Manga Chapters Data...")
                    database.end(function (err) {
                        if (err) {
                            return console.log('End db error:' + err.message);
                        }
                        console.log("Disconnected to database...\n-----------------")
                    })

                    return res.send({ success: true, message: "Insert successed" })
                })
            })
        })
    })
}

function checkPostExist(res, postSlug, source, name, path) {
    const getPostIdSql = `SELECT \`ID\` FROM \`${DB_PREFIX}_posts\` WHERE \`post_name\` = \"${postSlug}\"`
    database.query((getPostIdSql), async (err, results) => {
        if (err) {
            console.log("Get postID failed", err)
            return res.send({ success: false, message: "Get postID failed" })
        }
        if (results.length > 0) {
            return insertEachMangaChapter(res, postSlug, name, `${path}\/${name}`)
        }
        // Insert post
        let url = fs.readFileSync(`${path}/url.txt`, 'utf-8')
        url = url.split("|||")[0]
        const html = await cloudscraper.get(url)
        const $ = cheerio.load(html)
        const title = source === "bato" ? $(".item-title>a").text() : source === "zinmanga" ? $(".post-title>h1").text() : "Unknown"

        let summary = ""
        if (source === "bato") {
            summary = $("#limit-height-body-summary > .limit-html").text()
        } else if (source === "zinmanga") {
            summary = $(".summary__content > p").text()
        }
        const pathThumbnail = `${CURRENT_DOMAIN}\/${path}\/thumbnail.png`
        const insertSql = `INSERT INTO \`${DB_PREFIX}_posts\`(\`post_content\`, \`post_title\`, \`post_excerpt\`, \`post_name\`, \`to_ping\`, \`pinged\`, \`post_content_filtered\`, \`post_type\`) VALUES(\"${summary}\", \"${title}\", \"${pathThumbnail}\", \"${postSlug}\", \"\", \"\", \"\",\"wp-manga\")`
        database.query((insertSql), (err, result) => {
            if (err) {
                console.log(err)
                return res.send({ success: false, message: "Insert post failed" })
            }
            console.log("Upload to table Posts...")
            return insertEachMangaChapter(res, postSlug, name, `${path}\/${name}`)
        })
    })
}

function deleteEachChapterAndChapterData(res, chapterId, manga, name, path) {
    const delDataSql = `DELETE FROM \`${DB_PREFIX}_manga_chapters_data\` WHERE \`chapter_id\` = \"${chapterId}\";`
    database.query((delDataSql), (err) => {
        if (err) {
            console.log("Delete chapter data failed", err)
            return res.send({ success: false, message: "Delete chapter data failed" })
        }
        const delChapterSql = `DELETE FROM \`${DB_PREFIX}_manga_chapters\` WHERE \`chapter_id\` = \"${chapterId}\";`
        database.query((delChapterSql), (err) => {
            if (err) {
                console.log("Delete chapter failed", err)
                return res.send({ success: false, message: "Delete chapter failed" })
            }
            insertEachMangaChapter(res, manga, name, path)
        })
    })
}

app.post('/upload-chapter', async (req, res) => {
    try {
        const { source, manga, name, domain } = req.body
        const dirPath = './data'
        let status = fs.readFileSync(`${dirPath}/${source}/${manga}/url.txt`, 'utf-8')
        status = status.split("|||")[1] === "true"

        // DB Connecttion
        database = mysql.createConnection(status ? databaseConfig2 : databaseConfig);

        CURRENT_DOMAIN = domain
        try {
            // Check chapter exist
            const checkExistSql = `SELECT \`chapter_id\` FROM \`${DB_PREFIX}_manga_chapters\` WHERE \`chapter_name\` = \"${name}\" AND \`post_id\` IN (SELECT \`ID\` FROM \`${DB_PREFIX}_posts\` WHERE \`post_name\` = \"${manga}\")`
            database.query((checkExistSql), (err, result) => {
                if (err) {
                    console.log("Error: Check chapter exist", err)
                    return res.send({ success: false, message: "Error when check chapter exist" })
                }
                if (result.length > 0) {
                    deleteEachChapterAndChapterData(res, result[0].chapter_id, manga, name, `data\/${source}\/${manga}\/${name}`)
                } else {
                    checkPostExist(res, manga, source, name, `data\/${source}\/${manga}`)
                }
            })
        } catch (err) {
            console.log(err)
            return res.send({ success: false, message: "Try catch failed" })
        }
    } catch (err) {
        console.log(err)
        return res.send({ success: false, message: "Try catch failed" })
    }
})

app.get('/data', (req, res) => {
    try {
        let resData = []
        const dirPath = './data'
        // Array of names
        const webnames = fs.readdirSync(dirPath)
        webnames.forEach((web) => {
            const filenames = fs.readdirSync(`${dirPath}/${web}`)
            filenames.forEach(name => {
                // Get modified date
                const stat = fs.statSync(`${dirPath}/${web}/${name}`)
                const date = stat.mtime

                // Get nums of chapters
                const chapters = fs.readdirSync(`${dirPath}/${web}/${name}`)
                chapters.pop() // cut file url.txt
                chapters.pop() // cut file thumbnail.png
                const totalChapters = chapters.length

                // Get url of manga
                let url = fs.readFileSync(`${dirPath}/${web}/${name}/url.txt`, 'utf-8')
                let otherStore = url.split("|||")[1] === "true"
                url = url.split("|||")[0]

                // Get nums of images
                let totalImages = 0
                chapters.forEach(chapter => {
                    if (!chapter.includes("txt")) {
                        const images = fs.readdirSync(`${dirPath}/${web}/${name}/${chapter}`)
                        totalImages += images.length
                    }
                })

                const data = {
                    name: name,
                    allChapter: totalChapters,
                    allImage: totalImages,
                    dateModified: moment(date).fromNow(),
                    url: url,
                    otherStore: otherStore   // Check truyen cua server crawl hay server manga
                }
                resData = [
                    ...resData,
                    data
                ]
            })
        })
        return res.send(resData)

    } catch (err) {
        console.log(err);
    }
})

app.get('/data-chapter', async (req, res) => {
    try {
        const manga = req.query.manga
        const source = req.query.source
        let resData = []
        const dirPath = `./data/${source}/${manga}`
        // Array of chapters
        let chapters = fs.readdirSync(dirPath)

        chapters = chapters.filter(item => !(item.includes('url.txt') || item.includes('thumbnail.png')))

        // Get url of manga
        let url = fs.readFileSync(`${dirPath}/url.txt`, 'utf-8')
        url = url.split("|||")[0]


        let html = await cloudscraper.get(url)
        let $ = cheerio.load(html);

        // get chapter name in bato/zin
        let chapterInWeb = []
        if (source === 'bato') {
            const chapterEle = $("a[href^='/chapter']:has(b)")
            for (let index = 0; index < chapterEle.length; index++) {
                chapterInWeb.push(chapterEle.eq(index).text().trim().replace(/[/\\:?<>|\"]+/g, "").replace(/\s\s+/g, ' '))
            }
        } else if (source === 'zinmanga') {
            const chapterEle = $("li.wp-manga-chapter > a")
            for (let index = 0; index < chapterEle.length; index++) {
                chapterInWeb.push(chapterEle.eq(index).text().trim().replace(/[/\\:?<>|\"]+/g, "").replace(/\s\s+/g, ' ').replaceAll("\\n", ""))
            }
        }

        chapters = chapterInWeb.filter(item => chapters.includes(item))

        // Get nums of images
        chapters.forEach(chapter => {
            if (!chapter.includes("txt")) {
                const images = fs.readdirSync(`${dirPath}/${chapter}`)
                const stat = fs.statSync(`${dirPath}/${chapter}`)
                const date = stat.mtime
                const data = {
                    name: chapter,
                    images: images.length,
                    dateModified: moment(date).fromNow(),
                    url: url
                }
                resData = [
                    ...resData,
                    data
                ]
            }
        })

        return res.send(resData)

    } catch (err) {
        console.log(err);
    }
})

app.get('/map', (req, res) => {
    let data = JSON.parse(fs.readFileSync("./map.json").toString())
    return res.json({ success: true, data })
})

app.post('/check-new-manga', async (req, res) => {
    try {
        // get slug in bato/zin and slug in mangatic
        const { slugMangatic, linkManga } = req.body
        let name
        if (linkManga.includes("bato")) {
            name = linkManga.split('/').slice(-1)[0]
        } else if (linkManga.includes("zinmanga")) {
            name = linkManga.split('/')[linkManga.split('/').findIndex((item) => item === 'manga') + 1]
        }

        let dbChapters = 0
        // chapter in DB
        database = mysql.createConnection(databaseConfig);
        const findMangaSql = `SELECT \`ID\` FROM \`${DB_PREFIX}_posts\` WHERE \`post_name\` = \"${slugMangatic}\"`
        database.query((findMangaSql), (err, results) => {
            if (err) {
                console.log("Error while finding post", err)
                return res.send({ success: false, message: "Error while finding manga" })
            }
            if (results.length < 1) {
                return res.send({ success: false, message: "Manga not found" })
            }
            const postId = results[0].ID
            const countChaptersSql = `SELECT \`chapter_id\` FROM \`${DB_PREFIX}_manga_chapters\` WHERE \`post_id\` = \"${postId}\"`
            database.query((countChaptersSql), async (err, results) => {
                if (err) {
                    console.log("Error while counting chapters", err)
                    return res.send({ success: false, message: "Error while counting chapters" })
                }
                dbChapters = results.length

                // chapter in web
                const html = await cloudscraper.get(linkManga)
                let $ = cheerio.load(html);
                let chapterEle;
                let web
                let chapterNameWeb = []

                if (linkManga.includes("bato")) {
                    chapterEle = $("a[href^='/chapter']:has(b)")
                    web = 'bato'
                    for (let index = 0; index < chapterEle.length; index++) {
                        chapterNameWeb.push(chapterEle.eq(index).text().trim().replace(/[/\\:?<>|\"]+/g, "").replace(/\s\s+/g, ' '))
                    }
                } else if (linkManga.includes("zinmanga")) {
                    chapterEle = $("li.wp-manga-chapter > a")
                    web = 'zinmanga'
                    for (let index = 0; index < chapterEle.length; index++) {
                        chapterNameWeb.push(chapterEle.eq(index).text().trim().replace(/[/\\:?<>|\"]+/g, "").replace(/\s\s+/g, ' ').replaceAll("\\n", ""))
                    }
                }

                // download new chapter dir
                const dirPath = './data'
                // make file url.txt and thumnail
                if (!fs.existsSync(`${dirPath}/${web}/${name}`))
                    fs.mkdirSync(`${dirPath}/${web}/${name}`)
                fs.writeFileSync(`${dirPath}/${web}/${name}/url.txt`, linkManga + "|||true")
                fs.writeFileSync(`${dirPath}/${web}/${name}/thumbnail.png`, "")
                if (chapterNameWeb.length > dbChapters) {
                    chapterNameWeb.forEach((item, index) => {
                        if (chapterNameWeb.length - 1 - index >= dbChapters) {
                            if (!fs.existsSync(`${dirPath}/${web}/${name}/${item}`)) {
                                sleep(1000)
                                fs.mkdirSync(`${dirPath}/${web}/${name}/${item}`)
                            }
                        }
                    })
                }

                // update map
                let data = JSON.parse(fs.readFileSync("./map.json").toString())
                data = {
                    ...data,
                    [name]: {
                        name: slugMangatic,
                        numOfChapters: dbChapters
                    }
                }
                fs.writeFileSync('map.json', JSON.stringify(data))

                return res.json({ success: true, message: 'successfully' })
            })
        })

    } catch (error) {
        console.log(error);
        return res.status(500).json({ success: false, message: 'Server error' })
    }
})

app.post('/check-detail', async (req, res) => {
    try {
        const { chapterNames, manga, source } = req.body

        // count images by chapter name
        // return [{chapter: '', serverImage: , webImage: }]
        let data = []
        const mangaServer = fs.readdirSync(`${dirPath}/${source}/${manga}`)
            .sort((a, b) => {
                return fs.statSync(`${dirPath}/${source}/${manga}/` + a).mtime.getTime() -
                    fs.statSync(`${dirPath}/${source}/${manga}/` + b).mtime.getTime()
            })
        mangaServer.shift() // url.txt
        mangaServer.shift() // thumbnail.png
        let linkManga = fs.readFileSync(`${dirPath}/${source}/${manga}/url.txt`, 'utf-8')
        linkManga = linkManga.split("|||")[0]
        let html
        let $
        if (source === 'bato') {
            html = await cloudscraper.get(linkManga)
            $ = cheerio.load(html);
        }
        for (let i = 0; i < chapterNames.length; ++i) {
            // count in server
            const chapterServer = fs.readdirSync(`${dirPath}/${source}/${manga}/${chapterNames[i]}`)
            const serverImage = chapterServer.length

            // count in web
            let webImage = 0
            if (source === 'bato') {
                // get chapter link
                const chapterEle = $("a[href^='/chapter']:has(b)")
                let offsetChapter
                for (let id = 0; id < chapterEle.length; id++) {
                    if (chapterNames[i] === chapterEle.eq(id).text().trim().replace(/[/\\:?<>|\"]+/g, "").replace(/\s\s+/g, ' '))
                        offsetChapter = id
                }
                const linkChapter = "https://bato.to" + chapterEle.eq(offsetChapter).attr('href')
                // get image number
                console.log("link chapter", linkChapter);
                const images = await getLinksImageByChapter(linkChapter)
                webImage = images.length
            } else if (source === 'zinmanga') {
                const imagesURL = []
                html = await cloudscraper.get(linkManga + chapterNames[i].toLocaleLowerCase().split(' ').join('-'))
                $ = cheerio.load(html)
                $("div.page-break.no-gaps").toArray().forEach((_, index) => {
                    const uri = $(`img#image-${index}`).attr("data-src")
                    imagesURL.push(uri)
                })
                webImage = imagesURL.length
            }
            data.push({ chapter: chapterNames[i], serverImage, webImage })
        }

        return res.json({ success: true, data })

    } catch (error) {
        console.log(error);
        return res.status(500).json({ success: false, message: 'server error' })
    }
})

app.post('/crawl-chapters', async (req, res) => {
    try {
        const { chapterNames, manga, source } = req.body
        // get link chapters by chapterNames
        const chapters = []
        const mangaServer = fs.readdirSync(`${dirPath}/${source}/${manga}`)
        let linkManga = fs.readFileSync(`${dirPath}/${source}/${manga}/url.txt`, 'utf-8')
        linkManga = linkManga.split("|||")[0]
        let html
        let $
        if (source === 'bato') {
            html = await cloudscraper.get(linkManga)
            $ = cheerio.load(html);
        }
        for (let i = 0; i < chapterNames.length; ++i) {
            if (source === 'bato') {
                const chapterEle = $("a[href^='/chapter']:has(b)")
                let offsetChapter
                for (let id = 0; id < chapterEle.length; id++) {
                    if (chapterNames[i] === chapterEle.eq(id).text().trim().replace(/[/\\:?<>|\"]+/g, "").replace(/\s\s+/g, ' '))
                        offsetChapter = id
                }
                const linkChapter = "https://bato.to" + chapterEle.eq(offsetChapter).attr('href')
                chapters.push({
                    link: linkChapter,
                    name: chapterNames[i]
                })
            } else if (source === 'zinmanga') {
                const linkChapter = linkManga + chapterNames[i].toLocaleLowerCase().split(' ').join('-')
                chapters.push({
                    link: linkChapter,
                    name: chapterNames[i]
                })
            }
        }
        return res.json({ success: true, chapters })
    } catch (error) {
        console.log(error);
        return res.status(500).json({ success: false, message: 'server error' })
    }
})

function deleteFile(filename, callback) {
    if (fs.existsSync(filename)) {
        try {
            fsEx.remove(filename, (err) => {
                if (err) {
                    console.log("Error to remove file", err);
                    return callback(false)
                }
                return callback(true)
            })
        } catch (err) {
            console.log("Error to try delete file", err)
            callback(false)
        }
    } else {
        console.log("DeleteFile: Filename not exist");
        callback(false)
    }
}

io.on('connection', (socket) => {
    console.log('\n-----USER CONNECTED-----');
    var isConnected = true
    errorImages = 0
    socket.on("domain", ({ domain }) => {
        CURRENT_DOMAIN = domain
    })
    socket.on("download-bato", async ({ link }) => {
        try {
            const html = await cloudscraper.get(link)
            let $ = cheerio.load(html);

            // get name
            const name = link.split('/').slice(-1)[0]

            // get chapter
            const chapterEle = $("a[href^='/chapter']:has(b)")
            const chapters = []
            for (let i = 0; i < chapterEle.length; ++i) {
                let preName = chapterEle.eq(i).text().trim().replace(/[/\\:?<>|\"]+/g, "").replace(/\s\s+/g, ' ')
                chapters.push({
                    link: "https://bato.to" + chapterEle.eq(i).attr('href'),
                    name: preName
                })
            }

            // make dir
            let mainDir = `./data/bato/${name}`
            fsEx.emptyDirSync(mainDir)
            fs.writeFileSync(`./data/bato/${name}/url.txt`, link + "|||false")

            // download thumbnail
            const thumbnailLink = $("div.attr-cover > img").attr("src");
            await downloadImageByLink(thumbnailLink, `${mainDir}/thumbnail.png`, () => {
                console.log("Downloaded thumbnail...");
            })

            // download images
            let countImageDone = 0;
            let countChapterDone = 0;
            let allChapter = chapters.length;
            let allImage = 0;
            let allImageLink = []
            let promiseReadChapterArray = []
            for (let i = 0; i < chapters.length; ++i) {
                promiseReadChapterArray.push(getLinksImageByChapter(chapters[i].link))
                if ((i + 1) % 10 === 0 || i === chapters.length - 1) {
                    await Promise.all(promiseReadChapterArray).then((result) => {
                        allImage += result.reduce((curr, item) => curr + item.length, 0)
                        allImageLink = [...allImageLink, ...result]
                        console.log("Load chapter: " + i)
                        promiseReadChapterArray = []
                    })
                }
            }
            // Make first dir
            const chapterDir = `./data/bato/${name}/${chapters[0].name}`
            if (!fs.existsSync(chapterDir)) {
                fs.mkdirSync(chapterDir, { recursive: true });
            }
            for (let i = 0; i < allChapter; ++i) {
                const len = allImageLink[i].length
                let promiseAllArray = []
                for (let index = 0; index < len; ++index) {
                    if (!isConnected) {
                        console.log("Stop download..")
                        return null
                    }
                    const item = downloadImageByLink(allImageLink[i][index], `./data/bato/${name}/${chapters[i].name}/${index}_${CryptoJS.MD5(allImageLink[i][index])}.png`, () => {
                        countImageDone++;
                        if (index === len - 1) {
                            countChapterDone++;
                        }
                        socket.emit("download-status", {
                            allImage: allImage,
                            allChapter: allChapter,
                            chapter: countChapterDone,
                            image: countImageDone
                        })
                    })
                    promiseAllArray.push(item)
                    if ((index + 1) % 30 === 0 || index === len - 1) {
                        await Promise.all(promiseAllArray).then(() => {
                            promiseAllArray = []
                        }).catch((e) => console.log(e))
                    }
                }
                const chapterDir = `./data/bato/${name}/${chapters[i === allChapter - 1 ? i : i + 1].name}`
                if (!fs.existsSync(chapterDir)) {
                    fs.mkdirSync(chapterDir, { recursive: true });
                }
            }
            console.log("Download completed... Error images: " + errorImages)
            socket.emit("download-completed", errorImages)
        } catch (error) {
            console.log("bato error: " + error)
            socket.emit("download-completed", errorImages)
        }
    })

    socket.on("download-zinmanga", async ({ link }) => {
        try {
            cloudscraper.get(link).then(async (html) => {
                let $ = cheerio.load(html)
                // get name
                const nameIndex = link.split('/').findIndex((item) => item === 'manga')
                const name = link.split('/')[nameIndex + 1]

                // get chapter
                const chapterEle = $("li.wp-manga-chapter > a")
                const numsOfChapters = chapterEle.length
                const chapters = []
                for (let i = 0; i < chapterEle.length; ++i) {
                    chapters.push({
                        link: chapterEle.eq(i).attr("href"),
                        name: chapterEle.eq(i).text().trim().replace(/[/\\:?<>|\"]+/g, "").replace(/\s\s+/g, ' ').replaceAll("\\n", "")
                    })
                }

                // make dir
                let mainDir = `./data/zinmanga/${name}`
                fsEx.emptyDirSync(mainDir)
                fs.writeFileSync(`./data/zinmanga/${name}/url.txt`, link + "|||false")

                // download thumbnail
                const thumbnailLink = $("div.summary_image > a > img").attr("data-src");
                console.log(thumbnailLink);
                await downloadImageByLink(thumbnailLink, `${mainDir}/thumbnail.png`, () => {
                    console.log("Downloaded thumbnail...");
                })

                // total images
                let downloadedChapters = 0
                let totalImages = 0
                let allImage = 0;
                let allImageLink = []
                let promiseReadChapterArray = []
                for (let i = 0; i < numsOfChapters; ++i) {
                    const promiseReadChapter = async () => {
                        const html = await cloudscraper.get(chapters[i].link)
                        let $$ = cheerio.load(html)
                        const imagesURL = []
                        $$("div.page-break.no-gaps").toArray().forEach((_, index) => {
                            const uri = $$(`img#image-${index}`).attr("data-src")
                            imagesURL.push(uri)
                        })
                        allImageLink[i] = imagesURL
                        allImage += imagesURL.length
                        console.log("promiseReadChapter " + i)
                    }
                    promiseReadChapterArray.push(promiseReadChapter())
                    if ((i + 1) % 20 === 0 || i === numsOfChapters - 1) {

                        await Promise.all(promiseReadChapterArray).then(() => {
                            promiseReadChapterArray = []
                            console.log(allImageLink.length)
                        }).catch((e) => console.log("Error when get total: ", e))
                    }
                }

                // create first dir
                const chapterDir = `./data/zinmanga/${name}/${chapters[0].name}`
                if (!fs.existsSync(chapterDir)) {
                    fs.mkdirSync(chapterDir, { recursive: true })
                }
                for (let i = 0; i < numsOfChapters; ++i) {
                    const len = allImageLink[i].length
                    let promiseAllArray = []
                    for (let index = 0; index < len; ++index) {
                        if (!isConnected) {
                            console.log("Stop download..")
                            return null
                        }
                        const item = downloadImageByLink(allImageLink[i][index], `./data/zinmanga/${name}/${chapters[i].name}/${index}_${CryptoJS.MD5(allImageLink[i][index])}.png`, () => {
                            totalImages++;
                            if (index === len - 1) {
                                downloadedChapters++;
                            }
                            socket.emit("download-status", {
                                allChapter: numsOfChapters,
                                chapter: downloadedChapters,
                                image: totalImages,
                                allImage: allImage
                            })
                        })
                        promiseAllArray.push(item)
                        if ((index + 1) % 30 === 0 || index === len - 1) {
                            await Promise.all(promiseAllArray).then(() => {
                                promiseAllArray = []
                            }).catch((e) => console.log(e))
                        }

                    }
                    const chapterDir = `./data/zinmanga/${name}/${chapters[i === numsOfChapters - 1 ? i : i + 1].name}`
                    if (!fs.existsSync(chapterDir)) {
                        fs.mkdirSync(chapterDir, { recursive: true })
                    }
                }
                console.log("Download completed... Error images: " + errorImages)
                socket.emit("download-completed", errorImages)
            })
        } catch (error) {
            console.log("zinmanga error: " + error)
            socket.emit("download-completed", errorImages)
        }
    })

    socket.on("download-bato-chap", async ({ chapters, manga }) => {
        try {
            // download images
            let countImageDone = 0;
            let countChapterDone = 0;
            let allChapter = chapters.length;
            let allImage = 0;
            let allImageLink = []
            let promiseReadChapterArray = []
            for (let i = 0; i < chapters.length; ++i) {
                // delete before downloading
                let chapterDir = `./data/bato/${manga}/${chapters[i].name}`
                fsEx.emptyDirSync(chapterDir)

                promiseReadChapterArray.push(getLinksImageByChapter(chapters[i].link))
                if ((i + 1) % 10 === 0 || i === chapters.length - 1) {
                    await Promise.all(promiseReadChapterArray).then((result) => {
                        allImage += result.reduce((curr, item) => curr + item.length, 0)
                        allImageLink = [...allImageLink, ...result]
                        promiseReadChapterArray = []
                    })
                }
            }

            // Make first dir
            const chapterDir = `./data/bato/${manga}/${chapters[0].name}`
            if (!fs.existsSync(chapterDir)) {
                fs.mkdirSync(chapterDir, { recursive: true });
            }
            for (let i = 0; i < allChapter; ++i) {
                const len = allImageLink[i].length
                let promiseAllArray = []
                for (let index = 0; index < len; ++index) {
                    if (!isConnected) {
                        console.log("Stop download..")
                        return null
                    }
                    const item = downloadImageByLink(allImageLink[i][index], `./data/bato/${manga}/${chapters[i].name}/${index}_${CryptoJS.MD5(manga + chapters[i].name)}.png`, () => {
                        countImageDone++;
                        if (index === len - 1) {
                            countChapterDone++;
                        }
                        socket.emit("download-status", {
                            allImage: allImage,
                            allChapter: allChapter,
                            chapter: countChapterDone,
                            image: countImageDone
                        })
                    })
                    promiseAllArray.push(item)
                    if ((index + 1) % 30 === 0 || index === len - 1) {
                        await Promise.all(promiseAllArray).then(() => {
                            promiseAllArray = []
                        }).catch((e) => console.log(e))
                    }
                }
                const chapterDir = `./data/bato/${manga}/${chapters[i === allChapter - 1 ? i : i + 1].name}`
                if (!fs.existsSync(chapterDir)) {
                    fs.mkdirSync(chapterDir, { recursive: true });
                }
            }
            console.log("Download completed... Error images: " + errorImages)
            socket.emit("download-completed", errorImages)
        } catch (error) {
            console.log("Bato download chap error: ", error);
            socket.emit("download-completed", errorImages)
        }
    })

    socket.on("download-zinmanga-chap", async ({ chapters, manga }) => {
        try {
            // total images
            let downloadedChapters = 0
            let totalImages = 0
            let allImage = 0;
            let allImageLink = []
            let promiseReadChapterArray = []
            for (let i = 0; i < chapters.length; ++i) {
                let chapterDir = `./data/zinmanga/${manga}/${chapters[i].name}`
                fsEx.emptyDirSync(chapterDir)
                const promiseReadChapter = async () => {
                    const html = await cloudscraper.get(chapters[i].link)
                    let $$ = cheerio.load(html)
                    const imagesURL = []
                    $$("div.page-break.no-gaps").toArray().forEach((_, index) => {
                        const uri = $$(`img#image-${index}`).attr("data-src")
                        imagesURL.push(uri)
                    })
                    allImageLink[i] = imagesURL
                    allImage += imagesURL.length
                    console.log("promiseReadChapter " + i)
                }
                promiseReadChapterArray.push(promiseReadChapter())
                if ((i + 1) % 20 === 0 || i === chapters.length - 1) {

                    await Promise.all(promiseReadChapterArray).then(() => {
                        promiseReadChapterArray = []
                        console.log(allImageLink.length)
                    }).catch((e) => console.log("Error when get total: ", e))
                }
            }

            // create first dir
            const chapterDir = `./data/zinmanga/${manga}/${chapters[0].name}`
            if (!fs.existsSync(chapterDir)) {
                fs.mkdirSync(chapterDir, { recursive: true })
            }
            for (let i = 0; i < chapters.length; ++i) {
                const len = allImageLink[i].length
                let promiseAllArray = []
                for (let index = 0; index < len; ++index) {
                    if (!isConnected) {
                        console.log("Stop download..")
                        return null
                    }
                    const item = downloadImageByLink(allImageLink[i][index], `./data/zinmanga/${manga}/${chapters[i].name}/${index}_${CryptoJS.MD5(allImageLink[i][index])}.png`, () => {
                        totalImages++;
                        if (index === len - 1) {
                            downloadedChapters++;
                        }
                        socket.emit("download-status", {
                            allChapter: chapters.length,
                            chapter: downloadedChapters,
                            image: totalImages,
                            allImage: allImage
                        })
                    })
                    promiseAllArray.push(item)
                    if ((index + 1) % 30 === 0 || index === len - 1) {
                        await Promise.all(promiseAllArray).then(() => {
                            promiseAllArray = []
                        }).catch((e) => console.log(e))
                    }

                }
                const chapterDir = `./data/zinmanga/${manga}/${chapters[i === chapters.length - 1 ? i : i + 1].name}`
                if (!fs.existsSync(chapterDir)) {
                    fs.mkdirSync(chapterDir, { recursive: true })
                }
            }
            console.log("Download completed... Error images: " + errorImages)
            socket.emit("download-completed", errorImages)
        } catch (error) {
            console.log("Zinmanga download chap error: ", error);
            socket.emit("download-completed", errorImages)
        }
    })

    socket.on("disconnect", () => {
        console.log("\n-----USER DISCONNECTED-----")
        isConnected = false
        return null;
    })
});

server.listen(PORT, () => {
    console.log(`server listen in ${PORT}`);
})
