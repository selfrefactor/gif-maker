const Jimp = require('jimp')
const JPEG = require('jpeg-js')
const { mapParallelAsyncWithLimit, splitEvery, mapAsync, dropLast, takeLast } = require('rambdax')
const { scanFolder, execSafe } = require('helpers-fn')
Jimp.decoders[ 'image/jpeg' ] = data =>
  JPEG.decode(data, { maxMemoryUsageInMB : 2024 })

const [ subreddit ] = process.argv.slice(2)
if (!subreddit){
  throw new Error('No subreddit input')
}
const BATCH_SIZE = 360
const DEFAULT_DELAYS = [ 22 ].reverse()

const GIF_CREATE_ONLY = process.env.GIF_CREATE_ONLY === 'ON'
const WITH_COVER_FLAG = process.env.WITH_COVER_FLAG === 'ON'
const WITH_CONTAIN_FLAG = process.env.WITH_CONTAIN_FLAG === 'ON'
const DELAYS = process.env.DELAYS ?
  process.env.DELAYS.split(',').map(Number)
    .reverse() :
  DEFAULT_DELAYS

console.log({
  WITH_COVER_FLAG,
  WITH_CONTAIN_FLAG,
  DELAYS,
  GIF_CREATE_ONLY,
})

async function prepareImages(){
  const images = await scanFolder({
    folder   : `./assets/${ subreddit }/images`,
    filterFn : file =>
      file.endsWith('.jpg') ||
      file.endsWith('.png') ||
      file.endsWith('.jpeg'),
  })
  images.sort((a, b) => a.localeCompare(
    b, undefined, { numeric : true }
  ))
  console.log(images.length, 'images')
  const batches = splitEvery(BATCH_SIZE, images)
  const modifiedBatches = [...dropLast(2, batches), [...takeLast(2, batches)]]  
  await mapAsync(applyChanges, modifiedBatches)
}

async function applyChanges(images, i){
  console.log('batch size', images.length, i)
  const applyResize = async coverFlag => {
    const folder = coverFlag ?
      'resized/downloads-resized-cover' :
      'resized/downloads-resized-contain'
    await mapParallelAsyncWithLimit(
      async (imagePath, i) => {
        try{
          console.log(
            imagePath, coverFlag, i, 'start'
          )
          const outputPath = imagePath.replace('/assets/', `/${ folder }-${ i }/`)
          const image = await Jimp.read(imagePath)
          console.log(imagePath, 'read')
  
          const method = coverFlag ? 'cover' : 'contain'
          await image[ method ](2000, 1250) // resize
            .quality(100) // set JPEG quality
            .writeAsync(outputPath)
          console.log(imagePath, 'done')
        }catch(e){
          console.log(e, 'error')
          console.log(imagePath, 'error')
        }
      },
      1,
      images
    )
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

    await mapParallelAsyncWithLimit(
      async DELAY => {
        const coverPart = coverFlag ? '-cover' : ''
        const gifName = `${ subreddit }-${ i }-${ DELAY }${ coverPart }.gif`
        const gifArguments = `-src="${ folder }/${subreddit}/images/*.jpg" -delay=${ DELAY } -dest="gifs/${ gifName }" -verbose`
        const gifCommand = `goanigiffy ${ gifArguments }`
        console.log(gifCommand, 'gifCommand')
        await execSafe({
          command : gifCommand,
          cwd     : __dirname,
        })
      },
      2,
      DELAYS
    )
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
  console.log('batch size', images.length, i, 'END')
}

void (async function run(){
  await prepareImages()
})()
