import twitterText from "twitter-text";

interface Article {
  id: string;
  title: string;
  url: string;
  summary: string | null;
  published_date: string;
  source: string;
  tags: string[];
  keywords: string[];
}

interface ArticleWithScore extends Article {
  score: number;
}

function calculateImportanceScore(article: Article): number {
  let score = 0;

  // 基於關鍵字的重要性評分
  const importantKeywords = [
    // AI/Tech
    "AI",
    "artificial intelligence",
    "ChatGPT",
    "OpenAI",
    "Claude",
    "Anthropic",
    "Google",
    "Meta",
    "Microsoft",
    "Apple",
    "Tesla",
    "NVIDIA",
    "breakthrough",
    "突破",
    "innovation",
    "創新",

    // Business/Finance
    "funding",
    "融資",
    "IPO",
    "acquisition",
    "收購",
    "merger",
    "合併",
    "investment",
    "投資",
    "valuation",
    "估值",
    "billion",
    "million",

    // Regulation/Policy
    "regulation",
    "法規",
    "policy",
    "政策",
    "ban",
    "禁令",
    "lawsuit",
    "訴訟",
    "government",
    "政府",
    "congress",
    "國會",
    "senate",
    "參議院",

    // Security/Privacy
    "security",
    "安全",
    "privacy",
    "隱私",
    "breach",
    "洩露",
    "hack",
    "駭客",
    "vulnerability",
    "漏洞",
    "attack",
    "攻擊",

    // Crypto/Blockchain (if relevant)
    "Bitcoin",
    "Ethereum",
    "crypto",
    "加密貨幣",
    "blockchain",
    "區塊鏈",
  ];

  const titleLower = article.title.toLowerCase();
  const summaryLower = (article.summary || "").toLowerCase();

  // 標題中的關鍵字權重更高
  importantKeywords.forEach((keyword) => {
    if (titleLower.includes(keyword.toLowerCase())) score += 5;
    if (summaryLower.includes(keyword.toLowerCase())) score += 2;
  });

  // 基於標籤的評分
  const importantTags = [
    "AI",
    "Regulation",
    "Security",
    "Funding",
    "Layer1",
    "DeFi",
    "NFT",
    "GameFi",
    "DAO",
    "Exchange",
  ];
  if (article.tags && Array.isArray(article.tags)) {
    article.tags.forEach((tag: string) => {
      if (importantTags.includes(tag)) score += 3;
    });
  }

  // 基於來源的評分 - 權威來源給予更高分數
  const premiumSources = [
    "OpenAI",
    "Google Deepmind",
    "Anthropic",
    "CNBC",
    "Techcrunch",
    "Hacker News AI",
    "arXiv cs.AI",
    "arXiv cs.LG",
  ];
  if (premiumSources.includes(article.source)) {
    score += 4;
  }

  // 時間新鮮度評分 (越新越高分)
  const publishedTime = new Date(article.published_date).getTime();
  const hoursOld = (Date.now() - publishedTime) / (1000 * 60 * 60);

  if (hoursOld < 2) score += 5; // 2小時內
  else if (hoursOld < 6) score += 4; // 6小時內
  else if (hoursOld < 12) score += 3; // 12小時內
  else if (hoursOld < 24) score += 2; // 24小時內
  else if (hoursOld < 48) score += 1; // 48小時內

  // 標題長度適中的文章可能更重要
  const titleLength = article.title.length;
  if (titleLength > 20 && titleLength < 100) {
    score += 1;
  }

  return score;
}

export async function selectTopArticle(
  supabase: any
): Promise<ArticleWithScore | null> {
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);

  const { data: articles, error } = await supabase
    .from("articles")
    .select("id, title, url, summary, published_date, source, tags, keywords")
    .gte("published_date", fourHoursAgo.toISOString())
    .order("published_date", { ascending: false })
    .limit(100); // 取最新的100篇文章進行評估

  if (error) {
    console.error("Error fetching articles:", error);
    return null;
  }

  if (!articles || articles.length === 0) {
    console.log("No articles found in the last 4 hours");
    return null;
  }

  console.log(`Found ${articles.length} articles in the last 4 hours`);

  // 計算每篇文章的重要性分數
  const articlesWithScores: ArticleWithScore[] = articles.map(
    (article: Article) => ({
      ...article,
      score: calculateImportanceScore(article),
    })
  );

  // 按分數排序，選擇最高分的文章
  articlesWithScores.sort((a, b) => b.score - a.score);

  // 記錄前5名文章的分數，用於調試
  console.log("Top 5 articles by score:");
  articlesWithScores.slice(0, 5).forEach((article, index) => {
    console.log(
      `${index + 1}. Score: ${article.score} - ${article.title.substring(
        0,
        80
      )}...`
    );
  });

  return articlesWithScores[0];
}

interface GeminiResponse {
  choices: Array<{
    message: {
      content: string | null;
      role?: string;
    };
    finish_reason?: string;
    index?: number;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

async function callGemini(
  prompt: string,
  openrouterApiKey: string,
  temperature: number = 0.8
): Promise<string> {
  console.log(
    "Debug callGemini - API Key:",
    openrouterApiKey ? `${openrouterApiKey.substring(0, 20)}...` : "MISSING"
  );
  console.log("Debug callGemini - Prompt length:", prompt.length);
  console.log("Debug callGemini - Using model: google/gemini-2.5-flash-lite");

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openrouterApiKey}`,
        "HTTP-Referer": "https://app.newsence.xyz",
        "X-Title": "app.newsence.xyz",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        ],
        max_tokens: 400,
        temperature,
      }),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(
      "Gemini API Error:",
      response.status,
      response.statusText,
      errorBody
    );
    throw new Error(`Gemini API error: ${response.status} - ${errorBody}`);
  }

  const data: GeminiResponse = await response.json();
  console.log("Gemini API Response:", JSON.stringify(data, null, 2));

  const summary = data.choices?.[0]?.message?.content || "";
  console.log("Gemini Summary (length):", summary?.length || 0);
  console.log(
    "Gemini Summary (first 200 chars):",
    summary?.substring(0, 200) || "No content"
  );

  if (!summary || !summary.trim()) {
    throw new Error("Generated summary is empty");
  }

  return summary.trim();
}

export async function generateTwitterSummary(
  article: ArticleWithScore,
  openrouterApiKey: string
): Promise<string> {
  const maxCharacters = 240; // 為 URL 預留空間
  const maxRetries = 3;

  // 計算 URL 長度（Twitter 會自動縮短 URL 為 23 字符）
  const urlLength = 23;
  const availableChars = maxCharacters - urlLength - 4; // 減去 \n\n 和一些緩衝

  let attempt = 0;
  let finalTweet = "";

  while (attempt < maxRetries) {
    attempt++;

    const basePrompt = `作為一個專業的科技新聞分析師，請為以下新聞撰寫一則適合 Twitter 的簡潔評論推文：
		要求：
		1. 使用繁體中文
		2. 嚴格限制在 ${availableChars} 字符以內（包含中文字符、英文、標點符號、hashtag）
		3. 突出新聞的核心價值和重要性 語調專業但通俗易懂
		4. 使用1-2個相關的 hashtags (#AI #科技 #新聞 等)
		5. 不要包含連結 (會另外添加) 不要使用 emojis
    6. 永遠不要高度濃縮！ 不新增事實；專有名詞保留原文，並在括號中給出中文釋義（若轉錄出現或能直譯）。 盡量不使用 bullet points 除非很適合

		新聞資訊：
		標題: ${article.title}
		來源: ${article.source}
		摘要: ${article.summary || "無摘要"}
		重要性評分: ${article.score}/20`;

    // 根據嘗試次數調整 prompt
    let prompt = basePrompt;
    if (attempt === 2) {
      prompt += `\n\n注意：請更加簡潔，上次生成的內容太長了。限制在 ${availableChars} 字符以內。`;
    } else if (attempt === 3) {
      prompt += `\n\n重要：這是最後一次嘗試，請務必控制在 ${availableChars} 字符以內，可以犧牲一些細節來確保字數限制。`;
    }

    prompt += "\n\n請直接提供推文內容，不要其他說明：";

    console.log(`Attempt ${attempt}: Generating Twitter summary...`);

    const summary = await callGemini(
      prompt,
      openrouterApiKey,
      0.7 + attempt * 0.1
    );

    // 使用 twitter-text 精確計算字數
    const parsedTweet = twitterText.parseTweet(summary);
    const charCount = parsedTweet.weightedLength;
    console.log(
      `Generated summary character count: ${charCount}/${availableChars}`
    );
    console.log(`Summary: ${summary}`);

    if (charCount <= availableChars) {
      finalTweet = summary;
      break;
    } else {
      console.log(`Summary too long (${charCount} chars), retrying...`);
      if (attempt === maxRetries) {
        // 最後手段：強制截斷
        console.log("Max retries reached, truncating...");
        finalTweet = summary.substring(0, availableChars - 3) + "...";
      }
    }
  }

  // 添加文章連結
  const tweetWithUrl = `${finalTweet}\n\n${article.url}`;

  // 最終驗證總長度
  const finalParsed = twitterText.parseTweet(tweetWithUrl);
  const finalCharCount = finalParsed.weightedLength;
  console.log(
    `Final tweet character count: ${finalCharCount}/${maxCharacters}`
  );

  if (finalCharCount > maxCharacters) {
    console.warn(
      `Final tweet still exceeds limit: ${finalCharCount}/${maxCharacters}`
    );
    // 緊急截斷
    const emergencyTweet =
      finalTweet.substring(0, availableChars - 10) + "...\n\n" + article.url;
    const emergencyParsed = twitterText.parseTweet(emergencyTweet);
    console.log(
      `Emergency truncated tweet: ${emergencyParsed.weightedLength} chars`
    );
    return emergencyTweet;
  }

  return tweetWithUrl;
}
