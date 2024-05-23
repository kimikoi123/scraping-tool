const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const cliProgress = require("cli-progress");
const { convert } = require("html-to-text");

const COLLECTIONS_URL = "https://animepavilion.com/collections";

// Function to sanitize file names and change the extension to .webp
function sanitizeFilename(name) {
  const sanitizedFilename = name
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-"); // Replace invalid chars with hyphens and remove consecutive hyphens
  return sanitizedFilename + ".webp";
}

// Function to slugify collection names
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, ""); // Replace invalid chars with hyphens, remove leading/trailing hyphens
}

// Function to convert price to cents
function convertPriceToCents(price) {
  // Remove any non-digit characters
  const cleanedPrice = price.replace(/[^\d.-]/g, "");

  // Check if price has cents
  if (cleanedPrice.includes(".")) {
    return parseInt(cleanedPrice.replace(".", ""));
  } else {
    // If no cents, append two zeroes
    return parseInt(cleanedPrice + "00");
  }
}

// Function to get product description
async function getProductDescription(productLink) {
  try {
    const { data } = await axios.get(productLink);
    const $ = cheerio.load(data);

    // Remove unnecessary elements
    $(".product__description.rte.quick-add-hidden img").remove();
    $(".product__description.rte.quick-add-hidden script").remove();
    $(".product__description.rte.quick-add-hidden style").remove();
    $(".product__description.rte.quick-add-hidden noscript").remove();

    // Convert remaining HTML to text
    const descriptionHtml = $(
      ".product__description.rte.quick-add-hidden"
    ).html();
    const descriptionText = convert(descriptionHtml, {
      wordwrap: false, // Disable word wrapping to preserve original formatting
      selectors: [
        { selector: "img", format: "skip" }, // Skip images in description
        { selector: "a", options: { ignoreHref: true } }, // Convert links without URLs
        { selector: "br", format: "inline" }, // Convert <br> tags to line breaks
        {
          selector: "p",
          options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
        }, // Preserve paragraph breaks
      ],
    });

    // Additional text clean-up
    return descriptionText
      .replace(/\s\s+/g, " ") // Remove multiple spaces
      .replace(/\n\s*\n/g, "\n") // Remove multiple newlines
      .trim();
  } catch (error) {
    console.error(
      `Error getting product description ${productLink}: ${error.message}`
    );
    return "";
  }
}

async function scrapeAnimePavilion(downloadImages = false) {
  try {
    const { data } = await axios.get(COLLECTIONS_URL);
    const $ = cheerio.load(data);

    let collections = [];

    // Get all collection links
    const initial = [];

    $(
      ".collection-list__item.grid__item.scroll-trigger.animate--slide-in"
    ).each((index, element) => {
      const link = $(element).find(".full-unstyled-link").attr("href");
      const collectionName = $(element)
        .find(".card__heading .full-unstyled-link")
        .first()
        .text()
        .trim();
      const collectionImage = $(element)
        .find(".media.media--transparent.media--hover-effect img")
        .attr("src");

      initial.push({
        link: `https://animepavilion.com${link}`,
        collectionName,
        collectionImage,
        pathname: slugify(collectionName),
      });
    });

    // Ensure the download directory exists
    const downloadDir = "./images";
    if (downloadImages && !fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir);
    }

    // Calculate total steps for the progress bar
    let totalSteps = initial.length;
    for (const { link } of initial) {
      const { data: collectionData } = await axios.get(link);
      const $collection = cheerio.load(collectionData);
      totalSteps += $collection(
        ".grid__item.scroll-trigger.animate--slide-in"
      ).length;
    }

    // Initialize progress bar
    const progressBar = new cliProgress.SingleBar(
      {},
      cliProgress.Presets.shades_classic
    );
    progressBar.start(totalSteps, 0);

    // Loop through each collection link and scrape data
    for (const { link, collectionName, collectionImage, pathname } of initial) {
      const { data: collectionData } = await axios.get(link);
      const $collection = cheerio.load(collectionData);

      // Download collection image
      if (downloadImages && collectionImage) {
        const collectionImagePath = path.join(
          downloadDir,
          sanitizeFilename(collectionName)
        );
        await downloadImage(collectionImage, collectionImagePath);
      }

      let products = [];

      const productElements = $collection(
        ".grid__item.scroll-trigger.animate--slide-in"
      );

      for (let index = 0; index < productElements.length; index++) {
        const productElement = productElements[index];

        const title = $collection(productElement)
          .find(".card__heading.h5 .full-unstyled-link")
          .text()
          .trim();
        const regularPrice = $collection(productElement)
          .find(".price-item.price-item--regular")
          .last()
          .text()
          .trim();
        const salePrice = $collection(productElement)
          .find(".price-item.price-item--sale.price-item--last")
          .text()
          .trim();
        const productImage = $collection(productElement)
          .find(".media.media--transparent.media--hover-effect img")
          .attr("src");

        const productPath = $collection(productElement)
          .find(".card__heading.h5 .full-unstyled-link")
          .attr("href");
        const productLink = `https://animepavilion.com${productPath}`;

        // Get product description
        const productDescription = await getProductDescription(productLink);

        // Format prices as cents
        const formattedRegularPrice = convertPriceToCents(regularPrice);
        const formattedSalePrice = convertPriceToCents(salePrice);

        // Download product image
        if (downloadImages && productImage) {
          const productImagePath = path.join(
            downloadDir,
            sanitizeFilename(title)
          );
          await downloadImage(productImage, productImagePath);
        }

        products.push({
          id: uuidv4(),
          title,
          regularPrice: formattedRegularPrice,
          salePrice: formattedSalePrice,
          productImage,
          description: productDescription,
          link: productLink,
          collection: collectionName, // Add the collection name to each product
        });

        progressBar.increment();
      }

      collections.push({
        link,
        collectionName,
        collectionImage,
        products,
        pathname,
      });

      progressBar.increment();
    }

    progressBar.stop();

    // Save the data to a JSON file
    fs.writeFileSync("collections.json", JSON.stringify(collections, null, 2));
    console.log("Scraping completed and data saved to collections.json");
  } catch (error) {
    console.error("Error while scraping:", error);
  }
}

// Call the function with default downloadImages value (false)
scrapeAnimePavilion();
