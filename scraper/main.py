import asyncio
import datetime
import json
import sys
import logging
import pathlib
import re
import time
import warnings
from configparser import ConfigParser

import aiofiles
import aiohttp
import ffmpeg
from psaw import PushshiftAPI
from tqdm import tqdm, trange
from tqdm.asyncio import tqdm as async_tqdm

from utils import retry_connection, get_logger

subreddit = sys.argv[1]
if subreddit == None:
    raise Exception("No subreddit provided")

print(subreddit, "subreddit")

class SubredditDownloader:
    def __init__(self):
        self.log = get_logger(__name__, logging.DEBUG)
        self.config = ConfigParser()
        self.config.read('config.ini')
        self.bot_config = self.config['BOT']

        # Turn off warnings.
        warnings.filterwarnings('ignore')

        self.api = PushshiftAPI()
        self.session = self.set_session()

    @staticmethod
    def set_session():
        # Some image hosts (ahyes.fun) were throwing ssl errors, so we stop verifying certificates.
        conn = aiohttp.TCPConnector(limit=10, ssl=False)

        # If the subreddit is big, it could take a long time to download everything
        # and sooner or later the session expires, so we'll just disable timeouts.
        timeout = aiohttp.ClientTimeout(total=None)

        return aiohttp.ClientSession(connector=conn, timeout=timeout)

    async def run(self):
        # Get the total amount of submissions to download, this allows us to set the progressbar.
        try:
            total_submissions = await self.get_submissions_amount()
        except RuntimeError:
            print("No images found. Quitting...")
            return

        submissions = await self.get_submissions()
        print("\nSearching posts...", flush=True)
        elements = await self.get_elements_info(submissions, total_submissions)

        print("\nDownloading posts...", flush=True)
        await self.download_elements(elements)

    async def download_elements(self, links: dict):
        pattern = r'\.(jpe?g|png)'
        tasks = []
        for name, link in links.items():
            match = re.search(pattern, link)
            # Add the proper extension (png|jpg|mp4|gif) to the name.
            try:
                name += '.' + match.group(1)
            except AttributeError:
                print(f"Unrecognized link skipped. {link}")
                continue

            tasks.append(asyncio.create_task(self.download(name=name, url=link)))

        await async_tqdm.gather(*tasks, colour='green')

    async def get_submissions_amount(self):
        """ Get the total number of submissions """
        submissions = await self.get_submissions(ask_len=True)
        next(submissions)
        return self.api.metadata_['es']['hits']['total']['value']

    async def get_submissions(self, ask_len=False):
        # If we only want to know the total amount of submissions,
        # we can set a limit of 1 to be kind to PushShift api.
        limit = 1 if ask_len else None

        date_config = self.config['DATES']
        before = date_config['BEFORE'] or ''
        after = date_config['AFTER'] or ''

        if ask_len:
            if after and before:
                print(f"Scraping images from r/{subreddit} before {before} and after {after}")
            elif before:
                print(f"Scraping images from r/{subreddit} before {before}")
            elif after:
                print(f"Scraping images from r/{subreddit} after {after}")
            else:
                print(f"Scraping all images from r/{subreddit} ")

        try:
            if before:
                before = int(datetime.datetime.strptime(before, '%Y-%m-%d').timestamp())
            if after:
                after = int(datetime.datetime.strptime(after, '%Y-%m-%d').timestamp())
        except ValueError:
            print("Date format is wrong. Please use YYYY-MM-DD")
            print("Quitting...")
            await self.session.close()
            exit()

        return self.api.search_submissions(limit=limit,
                                           subreddit=subreddit,
                                           before=before,
                                           after=after,
                                           fields=['id',
                                                   'crosspost_parent_list',
                                                   'media',
                                                   'media_metadata',
                                                   'url',
                                                   'permalink']
                                           )

    async def get_elements_info(self, submissions, submissions_len) -> dict:
        elements = {}

        with tqdm(total=submissions_len, colour='green') as pbar:
            for sub in submissions:
                if not hasattr(sub, 'url'):
                    # Update progress bar status
                    pbar.update(1)
                    continue
                if re.search(r'\.(jpg|gif|png)$', sub.url):
                    elements[sub.id] = sub.url
                elif re.search(r'\.gifv$', sub.url):
                    link = await self.get_real_gif_link(sub.url)
                    if link:
                        elements[sub.id] = link
                elif sub.url.startswith('https://www.reddit.com/gallery/'):
                    try:
                        images = await self.parse_image(sub.id, sub.media_metadata)
                        for key, value in images.items():
                            elements[key] = value
                    except AttributeError:
                        # This happens with removed posts.
                        pass

                elif sub.url.startswith('https://v.redd.it/'):
                    video = await self.parse_video(sub)
                    if video:
                        elements[sub.id] = video
                else:
                    # External link. Ignore it.
                    pass
                # Update progress bar status
                pbar.update(1)
        return elements

    async def get_real_gif_link(self, link):
        return ''

    @retry_connection
    async def download(self, name, url) -> None:
        async with self.session.get(url) as response:
            if response.status == 404 or response.status == 403:
                # Image/Video has been deleted.
                # It's not a mistake, Reddit responds with 403 statuses with their deleted hosted videos.
                # See here: https://www.reddit.com/q1567e
                # And here: https://v.redd.it/stx7a2b1ofr71/DASH_720.mp4?source=fallback
                return

            content = await response.read()

            if url.startswith('https://v.redd.it'):
                print(f"Skip downloading video {url}")
            else:
                await self.write_to_disk(name=name, image=content)

    async def write_to_disk(self, name, image):
        """ Write the downloaded image/video/gif into the corresponding folder """
        dir_path = await self.get_file_dst_folder(name)

        file_path = dir_path / name
        f = await aiofiles.open(file_path, mode='wb')
        await f.write(image)
        await f.close()

    async def get_file_dst_folder(self, name):
        if name.endswith('mp4'):
            sub_folder = 'videos'
        elif name.endswith('gif') or name.endswith('gifv'):
            sub_folder = 'gifs'
        else:
            sub_folder = 'images'

        dir_path = pathlib.Path(self.bot_config['DOWNLOAD_FOLDER']) / subreddit / sub_folder
        try:
            dir_path.mkdir(parents=True, exist_ok=True)
            return dir_path
        except FileNotFoundError as error:
            print(error)
            print("Is your Download folder written correctly?")
            await self.session.close()
            exit()

    @staticmethod
    async def parse_image(id_, images):
        images_dict = {}

        for img_num, image in enumerate(images.values(), start=1):
            if image['status'] != 'completed':
                # Image was not processed? Does not contain any more info.
                continue

            url = image['s']['u']
            # Fix for api changes in images url. See here: https://reddit.com/9ncg2r
            url = url.replace('amp;', '')
            images_dict[id_ + f'_{img_num}'] = url

        return images_dict

async def main():
    t0 = time.perf_counter()

    downloader = SubredditDownloader()
    try:
        await downloader.run()
    except KeyboardInterrupt:
        print("Downloads cancelled. Goodbye!")
    except Exception:
        raise
    finally:
        if downloader.session:
            await downloader.session.close()

        print(f"\nExec time: {((time.perf_counter() - t0) / 60):.2f} minutes.")


if __name__ == '__main__':
    asyncio.run(main())
