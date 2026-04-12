export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const { message } = req.body;

      return res.status(200).json({
        reply: "You said: " + message
      });
    }

    res.status(200).json({ message: "API is working 🚀" });
  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
}
