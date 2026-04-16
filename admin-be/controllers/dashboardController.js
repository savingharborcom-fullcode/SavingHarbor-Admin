// controllers/dashboardController.js
import {supabase} from "../dbhelper/dbclient.js";

export async function getSummary(req, res) {
  try {
    const { data, error } = await supabase.rpc("get_dashboard_summary");
    if (error) throwSupabaseError(error, "getSummary");

    return res.json({ data, error: null });
  } catch (err) {
    console.error("Dashboard summary error:", err);
    return res
      .status(500)
      .json({ data: null, error: { message: err.message } });
  }
}
