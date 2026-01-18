const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const DATA_FILE = path.join(__dirname, "data", "history.json");

// YouTube API
app.get("/api/youtube", async (req, res) => {
  try {
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${process.env.YOUTUBE_CHANNEL_ID}&key=${process.env.YOUTUBE_API_KEY}`,
    );
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    res.json({
      current: parseInt(data.items[0].statistics.subscriberCount),
    });
  } catch (error) {
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

// Memberful API
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
                  plan { price }
                }
              }
            }
          }`,
        }),
      },
    );
    const data = await response.json();
    const subs = data.data.subscriptions.edges;
    const active = subs.filter((s) => s.node.active);
    const mrr = active.reduce(
      (sum, s) => sum + parseFloat(s.node.plan.price),
      0,
    );
    res.json({
      current: active.length,
      mrr: mrr,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Discord API
app.get("/api/discord", async (req, res) => {
  try {
    const response = await fetch(
      `https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}?with_counts=true`,
      {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        },
      },
    );
    const data = await response.json();
    res.json({ online: data.approximate_presence_count });
  } catch (error) {
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

const PORT = process.env.PORT || 3000;
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
    const subs = data.data.subscriptions.edges;

    // Calculate retention cohorts
    const now = new Date();
    const day7 = subs.filter((s) => {
      const created = new Date(s.node.createdAt);
      const daysSince = (now - created) / (1000 * 60 * 60 * 24);
      return daysSince >= 7 && s.node.active;
    });

    const day30 = subs.filter((s) => {
      const created = new Date(s.node.createdAt);
      const daysSince = (now - created) / (1000 * 60 * 60 * 24);
      return daysSince >= 30 && s.node.active;
    });

    const day90 = subs.filter((s) => {
      const created = new Date(s.node.createdAt);
      const daysSince = (now - created) / (1000 * 60 * 60 * 24);
      return daysSince >= 90 && s.node.active;
    });

    res.json({
      day7_retention: ((day7.length / subs.length) * 100).toFixed(1),
      day30_retention: ((day30.length / subs.length) * 100).toFixed(1),
      day90_retention: ((day90.length / subs.length) * 100).toFixed(1),
      monthly_churn: (
        (subs.filter((s) => !s.node.active).length / subs.length) *
        100
      ).toFixed(1),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
