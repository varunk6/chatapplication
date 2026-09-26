from django import forms
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.models import User
from .models import UserProfile


class RegisterForm(UserCreationForm):
    display_name = forms.CharField(
        max_length=100,
        required=False,
        widget=forms.TextInput(attrs={"placeholder": "Display name (e.g. Alex Doe)"})
    )
    email = forms.EmailField(
        required=False,
        widget=forms.EmailInput(attrs={"placeholder": "email@example.com"})
    )

    class Meta(UserCreationForm.Meta):
        model = User
        fields = ("username", "display_name", "email")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["username"].widget.attrs.update({"placeholder": "Choose a username"})
        for field in self.fields.values():
            field.widget.attrs.setdefault("class", "form-input")

    def save(self, commit=True):
        user = super().save(commit=False)
        display_name = self.cleaned_data.get("display_name", "").strip()
        email = self.cleaned_data.get("email", "").strip()
        user.email = email
        if commit:
            user.save()
            profile, _ = UserProfile.objects.get_or_create(user=user)
            if display_name:
                profile.display_name = display_name
                profile.save(update_fields=["display_name"])
                user.profile = profile
        return user



class ProfileUpdateForm(forms.ModelForm):
    email = forms.EmailField(required=False)

    class Meta:
        model = UserProfile
        fields = ("display_name", "bio", "avatar")
        widgets = {
            "display_name": forms.TextInput(attrs={"class": "form-input", "placeholder": "Your display name"}),
            "bio": forms.Textarea(attrs={"class": "form-input", "rows": 3, "placeholder": "A brief status or bio..."}),
            "avatar": forms.FileInput(attrs={"class": "form-file-input", "accept": "image/*"}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance and self.instance.user:
            self.fields["email"].initial = self.instance.user.email
            self.fields["email"].widget.attrs.update({"class": "form-input", "placeholder": "email@example.com"})

    def save(self, commit=True):
        profile = super().save(commit=commit)
        if commit and self.instance and self.instance.user:
            email = self.cleaned_data.get("email", "").strip()
            if profile.user.email != email:
                profile.user.email = email
                profile.user.save()
        return profile

