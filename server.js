const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = 3000;

app.get("/scrape", async (req, res) => {
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
          };
        })
        .filter((item) => item.productId); // Only return items with valid product IDs
    }, limit);

    console.log("products found:", products.length);

    await browser.close();
    res.json({ products });
  } catch (error) {
    console.error("Scraping error:", error);
    res.status(500).json({ error: "Scraping failed", details: error.message });
  }
});

const scrapeAmazonProduct = async (asin) => {
  const url = `https://www.amazon.de/-/en/dp/${asin}`; // Using English version of Amazon.de

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    // Set user agent to avoid detection
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    // Navigate to the URL with a longer timeout
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for price element to be available
    await page
      .waitForSelector("#productTitle, #price, .a-price", {
        timeout: 10000,
      })
      .catch(() => console.log("Some elements not found, continuing anyway"));

    // Scrape the necessary data
    const productDetails = await page.evaluate(() => {
      // Helper function to safely get text content
      const getText = (selector) => {
        const element = document.querySelector(selector);
        return element ? element.textContent.trim() : null;
      };

      // Helper function to get price
      const getPrice = () => {
        // Try different price selectors
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

      // Get all product features
      const features = Array.from(
        document.querySelectorAll("#feature-bullets li span")
      )
        .map((el) => el.textContent.trim())
        .filter((text) => text && !text.includes("Hide"));

      // Get product images
      const images = Array.from(document.querySelectorAll("#altImages img"))
        .map((img) => img.src)
        .filter((src) => src && !src.includes("sprite"));

      // Get main image
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
        mainImage: mainImage,
        additionalImages: images,
        // Additional details
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

    await browser.close();

    // Clean up the data
    return {
      ...productDetails,
      currentPrice:
        productDetails.currentPrice?.replace(/[^\d.,€]/g, "").trim() || null,
      rating: productDetails.rating?.replace(/[^0-9.]/g, "") || null,
      totalRatings: productDetails.totalRatings?.replace(/[^0-9]/g, "") || null,
      features: productDetails.features?.filter(Boolean) || [],
      additionalImages: productDetails.additionalImages?.filter(Boolean) || [],
    };
  } catch (error) {
    console.error("Error scraping product:", error);
    throw new Error("Failed to scrape product data: " + error.message);
  }
};

app.get("/info", async (req, res) => {
  const asin = req.query.asin;

  if (!asin) {
    return res.status(400).json({ error: "ASIN is required" });
  }

  try {
    const productData = await scrapeAmazonProduct(asin);
    res.json(productData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
