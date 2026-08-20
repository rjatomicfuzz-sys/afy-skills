export default async function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: "AFY_FREE_RANK_GATEWAY",
    googleCalled: false,
    sourceMode: "IDS_ONLY_FREE"
  });
}
