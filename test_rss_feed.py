# import xml.etree.ElementTree as ET
# import requests

# def fetch_hacker_news_rss():
#     url = "https://news.ycombinator.com/rss"
#     response = requests.get(url)
#     response.raise_for_status()  # Raise an error for bad status codes
#     return response.text

# def parse_hacker_news_rss(xml_string):
#     root = ET.fromstring(xml_string)
#     items = root.findall('.//item')

#     print(f"Found {len(items)} headlines in the feed.")
#     for i, item in enumerate(items, 1):
#         print("==========================================")
#         print(item)
#         print("==========================================")
#         title = item.find('title').text
#         link = item.find('link').text
#         pub_date = item.find('pubDate').text
#         comments = item.find('comments').text if item.find('comments') is not None else "N/A"

#         print(f"\n{i}. {title}")
#         print(f"   URL: {link}")
#         print(f"   Published: {pub_date}")
#         print(f"   Comments: {comments}")

# # Fetch and parse the RSS feed
# rss_data = fetch_hacker_news_rss()
# parse_hacker_news_rss(rss_data)
import requests
import feedparser  # Recommended for RSS parsing

def fetch_and_parse_rss_feed(url: str) -> list[dict]:
    """
    Fetches and parses an RSS feed from the given URL, returning a list of dictionaries
    containing key details of each item (title, link, description, pubDate, categories).

    Args:
        url (str): URL of the RSS feed.

    Returns:
        list[dict]: List of parsed feed items.
    """
    try:
        # Fetch the RSS feed
        response = requests.get(url)
        response.raise_for_status()  # Raise an error for bad status codes

        # Parse the feed using feedparser
        feed = feedparser.parse(response.content)

        # Extract relevant fields from each entry
        parsed_items = []
        for entry in feed.entries:
            parsed_item = {
                "title": entry.title,
                "link": entry.link,
                "description": entry.description,
                "pubDate": entry.published,
            }
            parsed_items.append(parsed_item)

        return parsed_items

    except Exception as e:
        raise Exception(f"Failed to parse RSS feed: {e}")

# Example usage:
# items = fetch_and_parse_rss_feed("https://feeds.arstechnica.com/arstechnica/index")
# print(items)
# Example usage:
if __name__ == "__main__":
    url = "https://feeds.arstechnica.com/arstechnica/index"
    try:
        items = fetch_and_parse_rss_feed(url)
        for item in items[:2]:  # Print first 2 items for brevity
            print(f"Title: {item['title']}")
            print(f"Link: {item['link']}")
            print(f"Published: {item['pubDate']}")
            print(f"Categories: {', '.join(item['categories'])}")
            print("---")
    except Exception as e:
        print(f"Error: {e}")