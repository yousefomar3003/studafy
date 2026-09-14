import { Link } from "react-router-dom";

/** Account settings page (`/account`) — the hub for the settings routes under it. */
export default function AccountPage() {
  return (
    <>
      <h1>Account</h1>
      <p>Manage your account settings.</p>
      <ul>
        <li>
          <Link to="/account/sessions">Devices &amp; sessions</Link>
        </li>
      </ul>
    </>
  );
}
