const express = require("express");
const puppeteer = require("puppeteer");
const cors = require("cors");

const app = express();
const PORT = 3000;

// add cors allow for 3001 port
app.use(cors({ origin: "http://localhost:3001" }));

// Global browser instance
let browser = null;

// Initialize browser
async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
      ],
    });
  }
  return browser;
}

// Batch processing helper
async function processBatch(items, batchSize, processor) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
    // Small delay between batches to prevent overload
    if (i + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return results;
}

const scrapeAmazonProduct = async (asin) => {
  const url = `https://www.amazon.de/-/en/dp/${asin}`;
  let page = null;

  try {
    page = await browser.newPage();

    // Optimize performance
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (
        ["image", "stylesheet", "font", "media"].includes(req.resourceType())
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    );

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const productDetails = await page.evaluate(() => {
      const getText = (selector) => {
        const element = document.querySelector(selector);
        return element ? element.textContent.trim() : null;
      };

      const getPrice = () => {
        const priceSelectors = [
          ".a-price .a-offscreen",
          "#price_inside_buybox",
          "#priceblock_ourprice",
          "#priceblock_dealprice",
          ".a-price-whole",
        ];

        for (const selector of priceSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            return element.textContent.trim();
          }
        }
        return null;
      };

      const features = Array.from(
        document.querySelectorAll("#feature-bullets li span")
      )
        .map((el) => el.textContent.trim())
        .filter((text) => text && !text.includes("Hide"));

      const images = Array.from(document.querySelectorAll("#altImages img"))
        .map((img) => img.src)
        .filter((src) => src && !src.includes("sprite"));

      const mainImage =
        document.querySelector("#landingImage")?.src ||
        document.querySelector("#imgBlkFront")?.src;

      return {
        title: getText("#productTitle"),
        currentPrice: getPrice(),
        originalPrice: getText(".basisPrice .a-text-price"),
        rating: getText("#acrPopover") || getText(".a-icon-star"),
        totalRatings: getText("#acrCustomerReviewText"),
        availability: getText("#availability"),
        description:
          getText("#productDescription p") ||
          getText("#bookDescription_feature_div") ||
          features.join(" | "),
        features: features,
        thumbnail: mainImage,
        additionalImages: images,
        manufacturer: getText("#bylineInfo"),
        category: getText("#wayfinding-breadcrumbs_feature_div"),
        dimensions: getText(
          "#productDetails_detailBullets_sections1 tr:nth-child(1) td"
        ),
        weight: getText(
          "#productDetails_detailBullets_sections1 tr:nth-child(2) td"
        ),
      };
    });

    return {
      ...productDetails,
      currentPrice:
        productDetails.currentPrice?.replace(/[^\d.,€]/g, "").trim() || null,
      rating: productDetails.rating?.replace(/[^0-9.]/g, "") || null,
      totalRatings: productDetails.totalRatings?.replace(/[^0-9]/g, "") || null,
      features: productDetails.features?.filter(Boolean) || [],
      images: productDetails.additionalImages?.filter(Boolean) || [],
    };
  } catch (error) {
    console.error(`Error scraping product ${asin}:`, error);
    return {};
  } finally {
    if (page) await page.close();
  }
};

app.get("/scrape", async (req, res) => {
  const url = req.query.url;
  const limit = parseInt(req.query.limit) || 0;

  if (!url) {
    return res.status(400).json({ error: "Please provide a wishlist URL" });
  }

  let page = null;

  try {
    await initBrowser();
    page = await browser.newPage();

    // Optimize performance
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (
        ["image", "stylesheet", "font", "media"].includes(req.resourceType())
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    );

    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Enhanced scroll function to load all items
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      let previousHeight = 0;
      let noChangeCount = 0;
      const maxNoChange = 3; // Stop if height doesn't change after 3 attempts

      while (noChangeCount < maxNoChange) {
        // Scroll to bottom
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(1000); // Wait for content to load

        const currentHeight = document.body.scrollHeight;
        if (currentHeight === previousHeight) {
          noChangeCount++;
        } else {
          noChangeCount = 0; // Reset counter if height changed
        }
        previousHeight = currentHeight;

        // Click "Show More" button if present
        const showMoreButton = document.querySelector(
          'input[name="submit.show-more"]'
        );
        if (showMoreButton) {
          showMoreButton.click();
          await sleep(1500); // Wait for new items to load
        }
      }
    });

    // Wait for items with increased timeout
    await page.waitForSelector("li[data-id]", { timeout: 30000 });

    // Get all products
    const products = await page.evaluate(async (limit) => {
      const items = document.querySelectorAll("li[data-id]");
      console.log("Total items found:", items.length);

      const itemsArray = Array.from(items);
      const limitedItems = limit > 0 ? itemsArray.slice(0, limit) : itemsArray;

      const results = [];
      for (const item of limitedItems) {
        const productId = item.getAttribute("data-itemid");
        const repoParams = item.getAttribute("data-reposition-action-params");

        const nameElement = item.querySelector(
          "h2, h3, [class*='a-text-normal']"
        );
        const name = nameElement ? nameElement.textContent.trim() : null;

        let price = null;
        const priceWhole = item.querySelector(".a-price-whole");
        const priceFraction = item.querySelector(".a-price-fraction");
        const priceSymbol = item.querySelector(".a-price-symbol");

        if (priceWhole || priceFraction) {
          const whole = priceWhole
            ? priceWhole.textContent.trim().replace(",", "")
            : "0";
          const fraction = priceFraction
            ? priceFraction.textContent.trim()
            : "00";
          const symbol = priceSymbol ? priceSymbol.textContent.trim() : "€";
          price = `${symbol}${whole}.${fraction}`;
        }

        const shippingElement = item.querySelector(
          "[class*='a-color-secondary']"
        );
        const shipping = shippingElement
          ? shippingElement.textContent.trim().replace(/\s+/g, " ")
          : null;

        let asin = null;
        if (repoParams) {
          try {
            const paramsObj = JSON.parse(repoParams);
            const itemExternalId = paramsObj.itemExternalId || "";
            const match = itemExternalId.match(/ASIN:([A-Z0-9]+)/);
            asin = match?.[1];
          } catch (e) {
            console.log("Error parsing params:", e);
          }
        }

        if (!productId) continue;

        const result = {
          productId,
          name,
          price,
          shipping,
        };

        if (asin) {
          result.asin = asin;
        }

        results.push(result);
      }

      return results;
    }, limit);

    // Process products in smaller batches to avoid overload
    const productsWithDetails = await processBatch(
      products,
      2,
      async (product) => {
        if (product.asin) {
          const details = await scrapeAmazonProduct(product.asin);
          // Add small delay between individual product scrapes
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { ...product, ...details };
        }
        return product;
      }
    );

    res.json({ products: productsWithDetails });
  } catch (error) {
    console.error("Scraping error:", error);
    res.status(500).json({ error: "Scraping failed", details: error.message });
  } finally {
    if (page) await page.close();
  }
});

app.get("/products", async (req, res) => {
  // url=https://www.amazon.de/hz/wishlist/ls/39AQJ5OKC2SJB/ref=hz_ls_biz_ex?viewType=list
  const url = req.query.url;
  const limit = parseInt(req.query.limit) || 0; // 0 means no limit

  if (!url) {
    return res.status(400).json({ error: "Please provide a wishlist URL" });
  }

  try {
    const browser = await puppeteer.launch({
      headless: true,
      // Add additional options to better handle modern websites
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    // Set a user agent to avoid being detected as a bot
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    await page.goto(url, { waitUntil: "networkidle2" });

    // Function to scroll to bottom and wait for new items
    async function scrollToBottom() {
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let totalHeight = 0;
          const distance = 200; // Increased scroll distance
          const timer = setInterval(() => {
            const scrollHeight = document.documentElement.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;

            if (totalHeight >= scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 50); // Reduced interval
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Reduced wait time
    }

    // If limit is set, only scroll once, otherwise scroll multiple times
    const scrollTimes = limit > 0 ? 1 : 3; // Reduced scroll times
    for (let i = 0; i < scrollTimes; i++) {
      await scrollToBottom();
    }

    // Wait for the wishlist items to load with the correct selector
    await page.waitForSelector("li[data-id]", { timeout: 10000 });

    console.log("page loaded", page);

    // Extract product IDs, names, and prices
    const products = await page.evaluate((limit) => {
      const items = document.querySelectorAll("li[data-id]");
      console.log("Found items:", items.length);

      // If limit is set, slice the items NodeList
      const itemsArray = Array.from(items);
      const limitedItems = limit > 0 ? itemsArray.slice(0, limit) : itemsArray;

      return limitedItems
        .map((item) => {
          const productId = item.getAttribute("data-itemid");
          const repoParams = item.getAttribute("data-reposition-action-params");

          // Get product name
          const nameElement = item.querySelector(
            "h2, h3, [class*='a-text-normal']"
          );
          const name = nameElement ? nameElement.textContent.trim() : null;

          // Get product price - new improved logic
          let price = null;
          const priceWhole = item.querySelector(".a-price-whole");
          const priceFraction = item.querySelector(".a-price-fraction");
          const priceSymbol = item.querySelector(".a-price-symbol");

          if (priceWhole || priceFraction) {
            const whole = priceWhole
              ? priceWhole.textContent.trim().replace(",", "")
              : "0";
            const fraction = priceFraction
              ? priceFraction.textContent.trim()
              : "00";
            const symbol = priceSymbol ? priceSymbol.textContent.trim() : "€";
            price = `${symbol}${whole}.${fraction}`;
          }

          // Get shipping price as additional info
          const shippingElement = item.querySelector(
            "[class*='a-color-secondary']"
          );
          const shipping = shippingElement
            ? shippingElement.textContent.trim().replace(/\s+/g, " ")
            : null;

          // Get product image
          const imageElement = item.querySelector("img[src]");
          const image = imageElement ? imageElement.src : null;

          let asin = null;
          if (repoParams) {
            try {
              const paramsObj = JSON.parse(repoParams);
              const itemExternalId = paramsObj.itemExternalId || "";
              const match = itemExternalId.match(/ASIN:([A-Z0-9]+)/);
              asin = match?.[1];
            } catch (e) {
              console.log("Error parsing params:", e);
            }
          }

          return {
            productId,
            asin,
            name,
            price,
            shipping,
            image,
          };
        })
        .filter((item) => item.productId); // Only return items with valid product IDs
    }, limit);

    console.log("products found:", products.length);

    await browser.close();
    res.json(products);
  } catch (error) {
    console.error("Scraping error:", error);
    res.status(500).json({ error: "Scraping failed", details: error.message });
  }
});

app.get("/products/:asin", async (req, res) => {
  const asin = req.query.asin;

  if (!asin) {
    return res.status(400).json({ error: "ASIN is required" });
  }

  try {
    await initBrowser();
    const productData = await scrapeAmazonProduct(asin);
    res.json(productData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cleanup on server shutdown
process.on("SIGINT", async () => {
  if (browser) {
    await browser.close();
  }
  process.exit();
});

app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
