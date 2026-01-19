const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Disable caching for API routes
app.use("/api", (req, res, next) => {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

app.use(
  express.static("public", {
    etag: false,
    maxAge: 0,
  }),
);

const DATA_FILE = path.join(__dirname, "data", "history.json");

// YouTube API
app.get("/api/youtube", async (req, res) => {
  try {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.YOUTUBE_API_KEY;
    const channelId = process.env.YOUTUBE_CHANNEL_ID;
    
    if (!apiKey || !channelId) {
      throw new Error("Missing YouTube API Key or Channel ID");
    }

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${apiKey}`,
    );
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    if (!data.items || data.items.length === 0) throw new Error("Channel not found");
    
    const stats = data.items[0].statistics;
    res.json({
      current: parseInt(stats.subscriberCount),
      subscribers: parseInt(stats.subscriberCount),
      views: parseInt(stats.viewCount),
      videos: parseInt(stats.videoCount),
    });
  } catch (error) {
    console.error("YouTube API error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Mailchimp API
app.get("/api/mailchimp", async (req, res) => {
  try {
    const response = await fetch(
      `https://${process.env.MAILCHIMP_SERVER}.api.mailchimp.com/3.0/lists/${process.env.MAILCHIMP_LIST_ID}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MAILCHIMP_API_KEY}`,
        },
      },
    );
    const data = await response.json();
    res.json({ current: data.stats.member_count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Memberful API (Fixed - use priceCents + LTV)
app.get("/api/memberful", async (req, res) => {
  try {
    const response = await fetch(
      `https://${process.env.MEMBERFUL_SUBDOMAIN}.memberful.com/api/graphql`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MEMBERFUL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `{
            subscriptions(first: 1000) {
              edges {
                node {
                  active
                  createdAt
                  plan { 
                    priceCents
                    name
                  }
                }
              }
            }
          }`,
        }),
      },
    );
    const data = await response.json();
    if (data.errors) {
      console.error("Memberful GraphQL errors:", data.errors);
      return res.status(500).json({ error: data.errors[0].message });
    }
    const subs = data.data.subscriptions.edges;
    const active = subs.filter((s) => s.node.active);

    // Classify plan type
    const getPlanType = (planName) => {
      const name = planName.toLowerCase();
      if (
        name.includes("annual") ||
        name.includes("yearly") ||
        name.includes("year")
      ) {
        return "annual";
      } else if (
        name.includes("6-month") ||
        name.includes("6 month") ||
        name.includes("semi")
      ) {
        return "6month";
      } else {
        return "monthly";
      }
    };

    // Get billing period in months based on plan type
    const getBillingMonths = (planType) => {
      if (planType === "annual") return 12;
      if (planType === "6month") return 6;
      return 1;
    };

    // Calculate MRR (normalize all plans to monthly)
    const mrr = active.reduce((sum, s) => {
      const planPrice = parseFloat(s.node.plan.priceCents) / 100;
      const planType = getPlanType(s.node.plan.name);
      const billingMonths = getBillingMonths(planType);
      return sum + planPrice / billingMonths;
    }, 0);

    // LTV calculation using new formula:
    // LTV = (monthly_count × 20 × monthly_price) + (6month_count × 6 × 6month_price) + (annual_count × 4 × annual_price)
    const TYPICAL_MONTHS = 20;
    const TYPICAL_HALF_YEAR = 6;
    const TYPICAL_YEAR = 4;

    // Group subscribers by plan type and get prices
    const planGroups = { monthly: [], "6month": [], annual: [] };
    active.forEach((s) => {
      const planType = getPlanType(s.node.plan.name);
      planGroups[planType].push(parseFloat(s.node.plan.priceCents) / 100);
    });

    // Calculate total LTV
    const monthlyLtv = planGroups.monthly.reduce(
      (sum, price) => sum + TYPICAL_MONTHS * price,
      0,
    );
    const sixMonthLtv = planGroups["6month"].reduce(
      (sum, price) => sum + TYPICAL_HALF_YEAR * price,
      0,
    );
    const annualLtv = planGroups.annual.reduce(
      (sum, price) => sum + TYPICAL_YEAR * price,
      0,
    );
    const ltv = monthlyLtv + sixMonthLtv + annualLtv;

    res.json({
      current: active.length,
      mrr: Math.round(mrr),
      ltv: Math.round(ltv),
    });
  } catch (error) {
    console.error("Memberful API error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Discord API (Full Insights)
app.get("/api/discord", async (req, res) => {
  try {
    const guildId = process.env.DISCORD_GUILD_ID;
    const botToken = process.env.DISCORD_BOT_TOKEN;

    // Get basic guild info
    const guildResponse = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}?with_counts=true`,
      {
        headers: {
          Authorization: `Bot ${botToken}`,
        },
      },
    );
    const guild = await guildResponse.json();

    // Get insights data (last 7 days)
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const insightsResponse = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/insights/member-insights?interval=7`,
      {
        headers: {
          Authorization: `Bot ${botToken}`,
        },
      },
    );

    let insights = {
      new_members_7d: null,
      messages_7d: null,
      active_members_7d: null,
      voice_participants_7d: null,
    };

    if (insightsResponse.ok) {
      const data = await insightsResponse.json();

      // Parse insights data
      if (data.members_joined) {
        insights.new_members_7d = data.members_joined.reduce(
          (sum, day) => sum + day.value,
          0,
        );
      }
      if (data.communicators) {
        insights.active_members_7d = data.communicators.reduce(
          (sum, day) => sum + day.value,
          0,
        );
      }
      if (data.messages_sent) {
        insights.messages_7d = data.messages_sent.reduce(
          (sum, day) => sum + day.value,
          0,
        );
      }
      if (data.voice_participants) {
        insights.voice_participants_7d = data.voice_participants.reduce(
          (sum, day) => sum + day.value,
          0,
        );
      }
    } else {
      console.log(
        "Insights not available (requires 500+ members or Community server)",
      );
    }

    res.json({
      online: guild.approximate_presence_count,
      total_members: guild.approximate_member_count,
      ...insights,
    });
  } catch (error) {
    console.error("Discord API error:", error);
    res.status(500).json({ error: error.message });
  }
});

// History endpoints
app.get("/api/history", async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, "utf8");
    res.json(JSON.parse(data));
  } catch (error) {
    res.json([]);
  }
});

app.post("/api/history", async (req, res) => {
  try {
    const snapshot = {
      date: new Date().toISOString(),
      ...req.body,
    };

    let history = [];
    try {
      const data = await fs.readFile(DATA_FILE, "utf8");
      history = JSON.parse(data);
    } catch (e) {}

    history.push(snapshot);
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(history, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
});

app.get("/api/retention", async (req, res) => {
  try {
    const response = await fetch(
      `https://${process.env.MEMBERFUL_SUBDOMAIN}.memberful.com/api/graphql`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MEMBERFUL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `{
            subscriptions(first: 1000) {
              edges {
                node {
                  active
                  createdAt
                  expiresAt
                }
              }
            }
          }`,
        }),
      },
    );
    const data = await response.json();

    if (data.errors) {
      return res.status(500).json({ error: data.errors[0].message });
    }

    const subs = data.data.subscriptions.edges;
    const now = new Date();

    // Cohorts: users who signed up 7, 30, 90 days ago
    const cohort7 = subs.filter((s) => {
      const created = new Date(s.node.createdAt);
      const daysAgo = (now - created) / (1000 * 60 * 60 * 24);
      return daysAgo >= 7 && daysAgo < 14; // Signed up 7-14 days ago
    });

    const cohort30 = subs.filter((s) => {
      const created = new Date(s.node.createdAt);
      const daysAgo = (now - created) / (1000 * 60 * 60 * 24);
      return daysAgo >= 30 && daysAgo < 37;
    });

    const cohort90 = subs.filter((s) => {
      const created = new Date(s.node.createdAt);
      const daysAgo = (now - created) / (1000 * 60 * 60 * 24);
      return daysAgo >= 90 && daysAgo < 97;
    });

    // How many are still active?
    const day7_retention =
      cohort7.length > 0
        ? (
            (cohort7.filter((s) => s.node.active).length / cohort7.length) *
            100
          ).toFixed(1)
        : 0;

    const day30_retention =
      cohort30.length > 0
        ? (
            (cohort30.filter((s) => s.node.active).length / cohort30.length) *
            100
          ).toFixed(1)
        : 0;

    const day90_retention =
      cohort90.length > 0
        ? (
            (cohort90.filter((s) => s.node.active).length / cohort90.length) *
            100
          ).toFixed(1)
        : 0;

    // Monthly churn = inactive subs / total subs
    const totalSubs = subs.length;
    const inactiveSubs = subs.filter((s) => !s.node.active).length;
    const monthly_churn = ((inactiveSubs / totalSubs) * 100).toFixed(1);

    res.json({
      day7_retention,
      day30_retention,
      day90_retention,
      monthly_churn,
    });
  } catch (error) {
    console.error("Retention API error:", error);
    res.status(500).json({ error: error.message });
  }
});

const { JWT } = require("google-auth-library");

// Google Analytics API
app.get("/api/analytics", async (req, res) => {
  try {
    // Create JWT client
    const client = new JWT({
      email: process.env.GA_CLIENT_EMAIL,
      key: process.env.GA_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    });

    // Get access token
    const token = await client.authorize();

    // Fetch GA data
    const response = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${process.env.GA_PROPERTY_ID}:runReport`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
          metrics: [
            { name: "activeUsers" },
            { name: "sessions" },
            { name: "screenPageViews" },
          ],
        }),
      },
    );

    const data = await response.json();

    res.json({
      active_users_7d: parseInt(data.rows?.[0]?.metricValues[0]?.value || 0),
      sessions_7d: parseInt(data.rows?.[0]?.metricValues[1]?.value || 0),
      pageviews_7d: parseInt(data.rows?.[0]?.metricValues[2]?.value || 0),
    });
  } catch (error) {
    console.error("GA API error:", error);
    res.status(500).json({ error: error.message });
  }
});
