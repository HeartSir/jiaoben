namespace VenueBookingUI;

partial class Form1
{
    private System.ComponentModel.IContainer components = null;
    private Microsoft.Web.WebView2.WinForms.WebView2 webView;

    protected override void Dispose(bool disposing)
    {
        if (disposing && (components != null))
        {
            components.Dispose();
        }
        base.Dispose(disposing);
    }

    private void InitializeComponent()
    {
        this.webView = new Microsoft.Web.WebView2.WinForms.WebView2();
        this.SuspendLayout();

        // webView
        this.webView.AllowExternalDrop = true;
        this.webView.CreationProperties = null;
        this.webView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(240, 242, 245);
        this.webView.Dock = System.Windows.Forms.DockStyle.Fill;
        this.webView.Name = "webView";
        this.webView.TabIndex = 0;
        this.webView.ZoomFactor = 1D;

        // Form1
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 17F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(1200, 800);
        this.Controls.Add(this.webView);
        this.MinimumSize = new System.Drawing.Size(800, 600);
        this.Name = "VenueBookingUI";
        this.Text = "🏸 川大场馆抢订系统";
        this.ResumeLayout(false);
    }
}
