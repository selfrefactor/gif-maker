const Jimp = require('jimp')
const JPEG = require('jpeg-js')
const {
  splitEvery,
  mapAsync,
  dropLast,
  takeLast,
  delay,
  flatten,
} = require('rambdax')
const { existsSync } = require('fs')
const { scanFolder, execSafe, exec } = require('helpers-fn')
Jimp.decoders[ 'image/jpeg' ] = data =>
  JPEG.decode(data, { maxMemoryUsageInMB : 2024 })

const [ subreddit ] = process.argv.slice(2)

if (!subreddit){
  throw new Error('No subreddit input')
}
const BATCH_SIZE = 360
const DEFAULT_DELAY = 22

const WITH_COVER_FLAG = process.env.WITH_COVER_FLAG === 'ON'
const WITH_CONTAIN_FLAG = process.env.WITH_CONTAIN_FLAG === 'ON'
const DELAY = process.env.DELAY ? Number(process.env.DELAY) : DEFAULT_DELAY

async function getImages(){
  if (!existsSync(`${ __dirname }/assets/${ subreddit }/images`)){
    return []
  }
  const images = await scanFolder({
    folder   : `./assets/${ subreddit }/images`,
    filterFn : file =>
      file.endsWith('.jpg') ||
      file.endsWith('.png') ||
      file.endsWith('.jpeg'),
  })

  return images
}

async function downloadImages(){
  if ((await getImages()).length > 0){
    console.log('already downloaded')

    return
  }
  const command = `python main.py ${ subreddit }`
  await exec({
    command,
    onLog : console.log,
    cwd   : `${ __dirname }/scraper`,
  })
}

async function prepareImages(){
  const images = await scanFolder({
    folder   : `./assets/${ subreddit }`,
    filterFn : file =>
      file.endsWith('.jpg') ||
      file.endsWith('.png') ||
      file.endsWith('.jpeg'),
  })
  if (images.length === 0){
    throw new Error('No images found')
  }
  images.sort((a, b) => a.localeCompare(
    b, undefined, { numeric : true }
  ))
  console.log(images.length, 'images')
  const batches = splitEvery(BATCH_SIZE, images)
  const modifiedBatches = [
    ...dropLast(2, batches),
    flatten(takeLast(2, batches)),
  ]
  modifiedBatches.forEach((batch, i) => {
    console.log(
      batch.length, i, 'modifiedBatches.length'
    )
  })

  return modifiedBatches
}

async function applyChanges(images, i){
  const applyResize = async coverFlag => {
    const folder = coverFlag ?
      'resized/downloads-resized-cover' :
      'resized/downloads-resized-contain'

    await mapAsync(async (imagePath, index) => {
      try {
        const outputPath = `${ __dirname }/${ folder }-${ i }/${ subreddit }/${ index }.jpg`
        if (existsSync(outputPath)){
          return
        }
        const image = await Jimp.read(imagePath)
        console.log(imagePath, 'read')

        const method = coverFlag ? 'cover' : 'contain'
        await image[ method ](2000, 1250).quality(100)
          .writeAsync(outputPath)
        console.log(imagePath, 'done')
      } catch (e){
        console.log(e, 'error')
        console.log(imagePath, 'error')
      }
    }, images)
  }
  console.log('start resize'.toUpperCase())

  if (WITH_CONTAIN_FLAG){
    await applyResize(false)
  }
  if (WITH_COVER_FLAG){
    await applyResize(true)
  }
  console.log('end resize'.toUpperCase())

  const applyGif = async coverFlag => {
    const folder = coverFlag ?
      `resized/downloads-resized-cover-${ i }` :
      `resized/downloads-resized-contain-${ i }`

    const coverPart = coverFlag ? '-cover' : ''
    const gifName = `${ subreddit }-${ i }-${ DELAY }${ coverPart }.gif`
    if (existsSync(`${ __dirname }/gifs/${ gifName }`)){
      console.log(gifName, 'exists')
      await delay(10000)

      return
    }
    const gifArguments = `-src="${ folder }/${ subreddit }/*.jpg" -delay=${ DELAY } -dest="gifs/${ gifName }" -verbose`
    const gifCommand = `goanigiffy ${ gifArguments }`
    console.log(gifCommand, 'gifCommand')
    await execSafe({
      command : gifCommand,
      cwd     : __dirname,
    })
  }
  console.log('start gif contain'.toUpperCase())
  if (WITH_CONTAIN_FLAG){
    await applyGif(false)
  }
  if (WITH_COVER_FLAG){
    console.log('start gif cover'.toUpperCase())
    await applyGif(true)
  }
  console.log('end gif'.toUpperCase())
  console.log(
    'batch size', images.length, i, 'END'
  )
}

void (async function run(){
  await downloadImages()
  const images = await prepareImages()
  await mapAsync(applyChanges, images)
})()
