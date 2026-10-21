import { BrowserRouter, Routes, Route } from "react-router-dom";

import LoginPage from "./pages/LoginPage";
import CreateAccountPage from "./pages/CreateAccountPage";
import SuccessPage from "./pages/SuccessPage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LoginPage />} />

        <Route
          path="/create-account"
          element={<CreateAccountPage />}
        />

        <Route 
        path="/success" element={<SuccessPage />} 
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;