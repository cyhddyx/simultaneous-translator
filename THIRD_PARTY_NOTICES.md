# Optional VB-CABLE Component

VB-CABLE is developed and owned by Vincent Burel / VB-Audio Software.
Official origin: https://www.vb-cable.com/ (https://vb-audio.com/Cable/).
VB-CABLE is donationware; all participation is welcome. Its license is separate
from this project's license. It is not a public-domain or self-developed driver.

The application downloads the unmodified standard Windows package only when the
user selects "Install official component". It verifies the archive's SHA-256 and
the original installer's Authenticode signature, then opens that installer for
the user to review and install. No driver is installed by the application setup,
no silent installation is performed, and no VB-CABLE binary is stored in this
repository. The original package, notices and installer remain unchanged.

## Licensing References

- Current product-specific distribution conditions:
  https://vb-audio.com/Services/licensing.htm, "VB-CABLE Distribution with other product".
- Donation / license purchase: https://shop.vb-audio.com/en/.
- Original package: https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip.
- SHA-256: `B950E39F01AF1D04EA623C8F6D8EB9B6EA5C477C637295FABF20631C85116BFB`.

The website's product-specific conditions (reviewed September 21, 2026) allow
distribution with free or commercial applications when the donationware model
remains applicable: the end user can identify VB-Audio and can donate or pay.
Professional/organizational use and distribution can require paid licenses;
distributors must review and satisfy those conditions for their deployment.
VB-CABLE A+B and C+D are expressly excluded from this integration.

The package's readme also contains an older restriction on integration in
another software's installation procedure without author agreement. This
application therefore leaves the vendor installer and its terms visible and
separate, downloads on demand, and exposes the current licensing and purchase
links in settings. This notice does not grant a license or replace the vendor's
terms. Review current terms before changing distribution or deployment scope.

## Operational Notes

Downloaded originals are retained in the current user's local application data
under `SimultaneousTranslator/components/VB-CABLE`. The optional driver is managed
by its original installer and is not removed when this application is uninstalled,
because other applications may use it. It may require a Windows restart.

# wasapi-rs

The system-audio capture helper uses wasapi 0.24.0, distributed under the MIT
license. Source: https://github.com/HEnquist/wasapi-rs.

Copyright (c) 2020 Henrik Enquist

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
